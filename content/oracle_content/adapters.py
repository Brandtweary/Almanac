"""Pinned local inference and Qdrant HTTP adapters; no cloud fallback."""
from __future__ import annotations
import asyncio
import math
import uuid
import sqlite3
import tempfile
import threading
import time
from contextlib import closing
from pathlib import Path
from urllib.parse import urlparse
import httpx
from .models import ContentError, Profile


def local_endpoint(url: str) -> str:
    parsed = urlparse(url)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname or parsed.username or parsed.password:
        raise ValueError("invalid service endpoint")
    # Private deployment networks are configured explicitly; model services never choose URLs.
    return url.rstrip("/")


def vectors_valid(vectors, count: int, dimensions: int):
    if not isinstance(vectors, list) or len(vectors) != count:
        raise ValueError("embedding cardinality mismatch")
    for vector in vectors:
        if not isinstance(vector, list) or len(vector) != dimensions or not all(
            type(v) in (int, float) and math.isfinite(v) for v in vector):
            raise ValueError("invalid embedding vector")
        if not any(vector):
            raise ValueError("zero embedding vector")
    return vectors


class Embeddings:
    def __init__(self, client: httpx.AsyncClient, url: str, profile: Profile, tokenizer):
        self.client, self.url, self.profile, self.tokenizer = client, local_endpoint(url), profile, tokenizer

    async def check(self):
        result = await self.client.get(self.url + "/info")
        result.raise_for_status()
        info = result.json()
        if info.get("model_id") != (self.profile.encoder_runtime_id or self.profile.encoder_id) or info.get("model_sha") != self.profile.encoder_revision:
            raise ValueError("embedding artifact identity mismatch")

    async def encode(self, texts):
        await self.check()
        if any(self.tokenizer.count(text) > self.profile.encoder_max_tokens for text in texts):
            raise ValueError("embedding input exceeds tokenizer window")
        response = await self.client.post(self.url + "/embed", json={"inputs": texts, "truncate": False})
        response.raise_for_status()
        return vectors_valid(response.json(), len(texts), self.profile.encoder_dimensions)


class Qdrant:
    def __init__(self, client: httpx.AsyncClient, url: str, embeddings: Embeddings, profile: Profile):
        self.client, self.url, self.embeddings, self.profile = client, local_endpoint(url), embeddings, profile

    def collection(self, generation):
        return self.url + "/collections/corpus_" + generation

    async def create(self, generation):
        response = await self.client.get(self.collection(generation))
        if response.status_code == 404:
            response = await self.client.put(self.collection(generation), json={
                "vectors": {"size": self.profile.encoder_dimensions, "distance": "Cosine", "on_disk": True,
                            "datatype": self.profile.vector_datatype},
                "on_disk_payload": True, "hnsw_config": {"on_disk": True}})
        response.raise_for_status()

    async def validate_native(self, generation, expected_count, expected_checksum):
        """Validate the complete acknowledged article-point set without a text catalog."""
        from .native import point_checksum
        response = await self.client.get(self.collection(generation))
        response.raise_for_status()
        config = response.json()["result"]["config"]["params"]["vectors"]
        if config["size"] != self.profile.encoder_dimensions or config["distance"] != "Cosine" or config.get("datatype", "float32") != self.profile.vector_datatype:
            raise ValueError("Native dense collection configuration mismatch")
        offset, count, checksum = None, 0, 0
        while True:
            body = {"limit": 1024, "with_payload": True, "with_vector": False}
            if offset is not None:
                body["offset"] = offset
            response = await self.client.post(self.collection(generation) + "/points/scroll", json=body)
            response.raise_for_status()
            result = response.json()["result"]
            for point in result["points"]:
                payload = point["payload"]
                if payload.get("generation") != generation or payload.get("encoder") != self.profile.index_fingerprint or point["id"] != str(uuid.uuid5(uuid.NAMESPACE_URL, payload["passage_id"])):
                    raise ValueError("Native dense identity mismatch")
                checksum = (checksum + point_checksum(payload["passage_id"], payload["document_id"])) % (1 << 256)
                count += 1
            offset = result.get("next_page_offset")
            if offset is None:
                break
        if count != expected_count or checksum != int(expected_checksum, 16):
            raise ValueError("Native dense coverage checksum/count mismatch")

    async def put(self, generation, passages):
        started = time.perf_counter()
        vectors = await self.embeddings.encode([p.embedding_text for p in passages])
        encoded = time.perf_counter()
        points = [{"id": str(uuid.uuid5(uuid.NAMESPACE_URL, p.passage_id)), "vector": vector,
            "payload": {"passage_id": p.passage_id, "document_id": p.document_id,
                        "generation": generation, "encoder": self.profile.index_fingerprint}}
            for p, vector in zip(passages, vectors, strict=True)]
        prepared = time.perf_counter()
        response = await self.client.put(self.collection(generation) + "/points?wait=true", json={"points": points})
        response.raise_for_status()
        self.last_timings = {"embedding_seconds": encoded - started, "point_preparation_seconds": prepared - encoded,
            "http_upsert_seconds": time.perf_counter() - prepared,
            "encoder": getattr(self.embeddings, "last_timings", {"available": False})}

    async def validate(self, generation, ids):
        response = await self.client.get(self.collection(generation))
        response.raise_for_status()
        info = response.json()["result"]
        vectors = info["config"]["params"]["vectors"]
        if vectors["size"] != self.profile.encoder_dimensions or vectors["distance"] != "Cosine" or vectors.get("datatype", "float32") != self.profile.vector_datatype:
            raise ValueError("dense collection configuration mismatch")
        response = await self.client.post(self.collection(generation) + "/points/count", json={"exact": True})
        response.raise_for_status()
        if response.json()["result"]["count"] != len(ids):
            raise ValueError("dense point count mismatch")
        # Activation inspects every identity and vector, not a count-only coincidence.
        offset = None
        with tempfile.TemporaryDirectory(prefix="dense-validation-", dir=getattr(getattr(ids, "store", None), "root", None)) as temporary:
            with closing(sqlite3.connect(Path(temporary) / "seen.sqlite")) as seen:
                seen.execute("CREATE TABLE ids(id TEXT PRIMARY KEY)")
                while True:
                    body = {"limit": self.profile.embedding_batch, "with_payload": True, "with_vector": True}
                    if offset is not None:
                        body["offset"] = offset
                    response = await self.client.post(self.collection(generation) + "/points/scroll", json=body)
                    response.raise_for_status()
                    result = response.json()["result"]
                    for point in result["points"]:
                        payload = point["payload"]
                        if payload.get("generation") != generation or payload.get("encoder") != self.profile.index_fingerprint:
                            raise ValueError("dense generation/encoder mismatch")
                        pid = payload.get("passage_id")
                        if pid not in ids or seen.execute("SELECT 1 FROM ids WHERE id=?", (pid,)).fetchone() or point["id"] != str(uuid.uuid5(uuid.NAMESPACE_URL, pid)):
                            raise ValueError("dense passage identity mismatch")
                        vectors_valid([point["vector"]], 1, self.profile.encoder_dimensions)
                        seen.execute("INSERT INTO ids VALUES(?)", (pid,))
                    offset = result.get("next_page_offset")
                    if offset is None:
                        break
                if seen.execute("SELECT count(*) FROM ids").fetchone()[0] != len(ids):
                    raise ValueError("dense identifiers differ from lexical index")

    async def search(self, generation, query, document_id=None):
        vector = (await self.embeddings.encode([self.profile.query_prefix + query]))[0]
        conditions = [{"key": "generation", "match": {"value": generation}},
                      {"key": "encoder", "match": {"value": self.profile.index_fingerprint}}]
        if document_id:
            conditions.append({"key": "document_id", "match": {"value": document_id}})
        response = await self.client.post(self.collection(generation) + "/points/query", json={
            "query": vector, "filter": {"must": conditions}, "limit": self.profile.dense_depth,
            "with_payload": True, "with_vector": False})
        response.raise_for_status()
        points = response.json()["result"]["points"]
        result = []
        for point in points:
            payload = point["payload"]
            if payload.get("generation") != generation or payload.get("encoder") != self.profile.index_fingerprint or (
                document_id and payload.get("document_id") != document_id):
                raise ValueError("dense result scope mismatch")
            if not math.isfinite(point["score"]):
                raise ValueError("nonfinite dense score")
            result.append((payload["passage_id"], point["score"]))
        return result


class Reranker:
    def __init__(self, client, url, profile, tokenizer):
        self.client, self.url, self.profile, self.tokenizer = client, local_endpoint(url), profile, tokenizer

    async def rank(self, query, passages):
        if any(self.tokenizer.pair_count(query, p.embedding_text) > self.profile.reranker_max_tokens for p in passages):
            raise ValueError("reranker pair exceeds qualified window")
        info = await self.client.get(self.url + "/info")
        info.raise_for_status()
        if (info.json().get("model_id") != (self.profile.reranker_runtime_id or self.profile.reranker_id) or
                info.json().get("model_sha") != self.profile.reranker_revision):
            raise ValueError("reranker identity mismatch")
        scores = {}
        for offset in range(0, len(passages), self.profile.reranker_batch):
            batch = passages[offset:offset + self.profile.reranker_batch]
            response = await self.client.post(self.url + "/rerank", json={"query": query,
                "texts": [p.embedding_text for p in batch], "truncate": False})
            response.raise_for_status()
            rows = response.json()
            if not isinstance(rows, list) or len(rows) != len(batch):
                raise ValueError("reranker cardinality mismatch")
            seen = set()
            for row in rows:
                index, score = row.get("index"), row.get("score")
                if type(index) is not int or index not in range(len(batch)) or index in seen or (
                    type(score) not in (int, float) or not math.isfinite(score)):
                    raise ValueError("reranker ID/score mismatch")
                seen.add(index)
                scores[batch[index].passage_id] = score
        return scores



class ZimLexical:
    """Serialize native search even when its awaiting request is cancelled."""
    def __init__(self):
        self.lock = threading.Lock()

    @staticmethod
    def _with_exact_title(archive, query, paths, limit):
        # Full-text BM25 can bury a long article beneath pages repeating its
        # title. The archive's title index supplies an exact navigation hit.
        title = query.strip().replace("_", " ")
        for candidate in dict.fromkeys((title, title[:1].upper() + title[1:])):
            try:
                entry = archive.get_entry_by_title(candidate)
            except KeyError:
                continue
            return [entry.path, *(path for path in paths if path != entry.path)][:limit]
        return paths

    async def search(self, path, query, limit, *, title_query=None):
        def run():
            from libzim.reader import Archive
            from libzim.search import Query, Searcher
            with self.lock:
                archive = Archive(path)
                if not archive.has_fulltext_index:
                    raise ValueError("declared native ZIM index unavailable")
                result = Searcher(archive).search(Query().set_query(query))
                paths = list(dict.fromkeys(archive.get_entry_by_path(path).get_item().path for path in result.getResults(0, limit)))
                return self._with_exact_title(archive, title_query, paths, limit) if title_query is not None else paths
        return await asyncio.to_thread(run)
