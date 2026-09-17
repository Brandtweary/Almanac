from __future__ import annotations
import asyncio
import hashlib
import json
import math
import os
import traceback
import re
import sqlite3
import uuid
from contextvars import ContextVar
from pathlib import Path
from urllib.parse import quote
from .models import ContentError, Profile, SearchRequest, ReadRequest, Passage, digest
from .store import HANDLE, Store, atomic_json


request_id = ContextVar("content_request_id", default=None)

def fuse(branches, weights, k):
    scores, origins = {}, {}
    for branch, rows in branches.items():
        seen = set()
        for pid, _score in rows:
            if pid in seen:
                continue
            seen.add(pid)
            rank = len(seen)
            scores[pid] = scores.get(pid, 0) + weights[branch] / (k + rank)
            origins.setdefault(pid, {})[branch] = rank
    return [{"passage_id": pid, "score": score, "ranks": origins[pid]}
            for pid, score in sorted(scores.items(), key=lambda item: (-item[1], item[0]))]


def remove_contained(rows, passages):
    kept = []
    for row in rows:
        p = passages[row["passage_id"]]
        contained = False
        for other in rows:
            q = passages[other["passage_id"]]
            if q.passage_id == p.passage_id:
                continue
            same = (p.document_id, p.source_revision, p.extraction_revision, p.block_index) == (
                q.document_id, q.source_revision, q.extraction_revision, q.block_index)
            if same and q.start <= p.start and q.end >= p.end and (
                (q.start, q.end) != (p.start, p.end) or q.passage_id < p.passage_id):
                if p.text == q.text[p.start - q.start:p.end - q.start]:
                    contained = True
                    break
        if not contained:
            kept.append(row)
    return kept


class Service:
    def __init__(self, store: Store, profile: Profile, dense, tokenizer, zim=None, reranker=None):
        self.store, self.profile, self.dense, self.tokenizer = store, profile, dense, tokenizer
        self.zim, self.reranker = zim, reranker

    def record_failure(self, stage, generation, error):
        # Traceback frames retain mechanism evidence without serializing query-bearing exception text.
        record = {"request_id": request_id.get(), "stage": stage, "generation": generation, "type": type(error).__name__,
                  "traceback": traceback.format_tb(error.__traceback__)}
        try:
            fd = os.open(self.store.root / "failures.jsonl", os.O_APPEND | os.O_CREAT | os.O_WRONLY, 0o600)
            try:
                os.write(fd, (json.dumps(record) + "\n").encode())
            finally:
                os.close(fd)
        except OSError:
            pass  # Failure reporting cannot replace the original retrieval failure.

    def health(self):
        try:
            generation = self.store.active()
            generations = self.store.active_generations()
            ready, dense_complete = True, True
            for source_generation in generations:
                manifest = self.store.manifest(source_generation)
                ready = ready and manifest["index_fingerprint"] == self.profile.index_fingerprint
                native = self.store.native(source_generation)
                if native is not None:
                    native.verify_original()
                    ready = ready and native.archive.has_fulltext_index
                    dense_complete = dense_complete and manifest.get("dense_stage") == "complete"
                else:
                    with self.store.connect(source_generation) as db:
                        ready = ready and db.execute("SELECT 1 FROM passages LIMIT 1").fetchone() is not None
        except (ContentError, sqlite3.Error):
            generation, ready, dense_complete = None, False, False
        return {"ready": ready, "generation": generation, "profile_id": self.profile.profile_id,
                "qualified": self.profile.qualified and dense_complete, "coverage": self.store.coverage(generation)}

    def base(self, generation, degradation=None):
        degradation = degradation or []
        return {"generation": generation, "profile_id": self.profile.profile_id,
                "status": "degraded" if degradation else "ok" if self.profile.qualified else "unqualified",
                "degradation": degradation, "coverage": self.store.coverage(generation)}

    def active(self):
        generation = self.store.active()
        if self.store.manifest(generation)["index_fingerprint"] != self.profile.index_fingerprint:
            raise ContentError("profile_mismatch", "Active corpus uses a different release profile")
        return generation

    async def lexical(self, generation, query, document_id):
        native = self.store.native(generation)
        if native is not None:
            if self.zim is None:
                raise ValueError("native ZIM lexical adapter unavailable")
            return await native.lexical(self.zim, query, self.profile.lexical_depth, document_id)
        rows = self.store.lexical(generation, query, self.profile.lexical_depth, document_id)
        with self.store.connect(generation) as db:
            sql = "SELECT DISTINCT original_path FROM documents WHERE native=1"
            params = ()
            if document_id:
                sql += " AND id=?"
                params = (document_id,)
            paths = [r[0] for r in db.execute(sql, params)]
        if paths and self.zim is None:
            raise ValueError("native ZIM lexical adapter unavailable")
        branches = {"extracted": rows}
        safe_query = " OR ".join('"' + t.replace('"', '') + '"' for t in re.findall(r"[^\W_]+", query))
        for index, path in enumerate(paths):
            hits = await self.zim.search(str(self.store.root / path), safe_query, self.profile.lexical_depth)
            article_branches, article_weights = {}, {}
            with self.store.connect(generation) as db:
                for article_rank, article in enumerate(hits, 1):
                    scope = " AND id=?" if document_id else ""
                    args = (path, article, document_id) if document_id else (path, article)
                    found = db.execute("SELECT id FROM documents WHERE original_path=? AND article_path=?" + scope, args).fetchone()
                    if not found:
                        continue
                    # Localize within each native article hit, never rebuild the whole archive's lexical index.
                    local = sqlite3.connect(":memory:")
                    try:
                        local.execute("CREATE VIRTUAL TABLE article USING fts5(id UNINDEXED,text,tokenize='porter unicode61')")
                        for row in db.execute("SELECT id,data FROM passages WHERE document_id=? ORDER BY ordinal", (found[0],)):
                            passage = Passage.model_validate_json(row[1])
                            local.execute("INSERT INTO article VALUES(?,?)", (row[0], passage.lexical_text))
                        lexical_query = " OR ".join('"' + token.replace('"', '""') + '"'
                            for token in re.findall(r"[^\W_]+(?:[-./][^\W_]+)*", query, re.UNICODE))
                        localized = local.execute("SELECT id,bm25(article) FROM article WHERE article MATCH ? ORDER BY bm25(article),id LIMIT ?",
                                                  (lexical_query, self.profile.lexical_depth)).fetchall() if lexical_query else []
                    finally:
                        local.close()
                    if not localized:
                        # Native title/redirect/stem matches still locate an article even without literal passage terms.
                        localized = [(r[0], 0) for r in db.execute(
                            "SELECT id FROM passages WHERE document_id=? ORDER BY ordinal LIMIT ?",
                            (found[0], self.profile.lexical_depth))]
                    if localized:
                        article_branches[article] = localized
                        article_weights[article] = 1 / (self.profile.rrf_k + article_rank)
            native = fuse(article_branches, article_weights, self.profile.rrf_k)
            branches[f"zim{index}"] = [(r["passage_id"], r["score"]) for r in native[:self.profile.lexical_depth]]
        if len(branches) == 1:
            return rows
        return [(row["passage_id"], row["score"]) for row in fuse(branches, {k: 1 for k in branches}, self.profile.rrf_k)][:self.profile.lexical_depth]

    async def candidates(self, query, document_id=None, generation=None):
        """Evaluation seam: independent ranks and fused pool before reranking/packing."""
        if generation is None:
            generations = self.store.active_generations()
            if document_id:
                scoped = []
                for candidate in generations:
                    try:
                        self.store.document(candidate, document_id)
                        scoped.append(candidate)
                    except ContentError as error:
                        if error.code not in {"unknown_document", "source_excluded"}:
                            raise
                if not scoped:
                    raise ContentError("unknown_document", "Document is outside the active library", 404)
                generations = scoped
            if len(generations) > 1:
                pools = await asyncio.gather(*(self.candidates(query, document_id, value) for value in generations))
                # Fuse source-local ranks, not incomparable raw BM25/dense scores.
                branches = {name: [(row["passage_id"], row["score"]) for row in
                    fuse({str(i): pool["branches"][name] for i, pool in enumerate(pools)},
                         {str(i): 1 for i in range(len(pools))}, self.profile.rrf_k)]
                    for name in ("lexical", "dense")}
                rows = fuse(branches, {"lexical": self.profile.lexical_weight, "dense": self.profile.dense_weight}, self.profile.rrf_k)
                passages = {key: value for pool in pools for key, value in pool["passages"].items()}
                return {"generation": generations[0], "generations": generations, "branches": branches,
                        "rows": remove_contained(rows, passages), "passages": passages,
                        "degradation": sorted({value for pool in pools for value in pool["degradation"]})}
            generation = generations[0]
        generation = generation or self.active()
        if self.store.manifest(generation)["index_fingerprint"] != self.profile.index_fingerprint:
            raise ContentError("profile_mismatch", "Active corpus uses a different release profile")
        if document_id:
            self.store.document(generation, document_id)
        lexical, dense = await asyncio.gather(self.lexical(generation, query, document_id),
            self.dense.search(generation, query, document_id), return_exceptions=True)
        if isinstance(lexical, BaseException):
            if isinstance(lexical, asyncio.CancelledError):
                raise lexical
            self.record_failure("lexical", generation, lexical)
            raise ContentError("lexical_unavailable", "Lexical retrieval failed; search was not completed") from lexical
        degradation = []
        if self.store.manifest(generation).get("kind") == "native-zim-article-v1" and self.store.manifest(generation).get("dense_stage") != "complete":
            degradation.append("dense_index_incomplete")
        if isinstance(dense, BaseException):
            if isinstance(dense, asyncio.CancelledError):
                raise dense
            self.record_failure("dense", generation, dense)
            dense = []
            degradation.append("dense_unavailable")
        rows = fuse({"lexical": lexical, "dense": dense},
                    {"lexical": self.profile.lexical_weight, "dense": self.profile.dense_weight}, self.profile.rrf_k)
        passages = {}
        for row in rows:
            p = getattr(lexical, "passages", {}).get(row["passage_id"]) or self.store.passage(generation, row["passage_id"])
            if document_id and p.document_id != document_id:
                raise ContentError("index_scope_mismatch", "Candidate escaped its document scope")
            passages[p.passage_id] = p
        return {"generation": generation, "branches": {"lexical": lexical, "dense": dense},
                "rows": remove_contained(rows, passages), "passages": passages, "degradation": degradation}

    def hit(self, generation, passage, omit=False):
        generation = HANDLE.fullmatch(passage.passage_id)[1]
        doc = self.store.document(generation, passage.document_id)
        return {"passage_id": passage.passage_id, "document_id": doc.document_id,
                "source_revision": passage.source_revision, "extraction_revision": passage.extraction_revision,
                "title": doc.title, "edition": doc.edition, "section": passage.section, "page": passage.page,
                "excerpt": "" if omit else passage.text,
                "complete": not omit and not any(f in passage.flags for f in ("continued_source_block", "text_omitted")),
                "source": {"url": "/v1/corpus/source/" + quote(passage.passage_id, safe=""),
                           "sha256": doc.sha256, "media_type": doc.media_type, "origin": doc.source_url,
                           "representation": "article_text" if doc.media_type == "application/x-zim" else "original"},
                "previous": passage.previous, "next": passage.next, "kind": passage.kind,
                "flags": passage.flags + (["text_omitted_budget"] if omit else [])}

    def save_snapshot(self, data, binding):
        key = uuid.uuid4().hex
        atomic_json(self.store.root / "snapshots" / (key + ".json"), {"binding": binding, "data": data})
        return key

    def cursor(self, key, offset):
        # Opaque random snapshot IDs are server-issued capabilities; the offset grants no extra scope.
        return f"{key}:{offset}"

    def resume(self, cursor, binding):
        if not re.fullmatch(r"[a-f0-9]{32}:[0-9]{1,9}", cursor):
            raise ContentError("invalid_cursor", "Malformed continuation cursor", 400)
        key, offset = cursor.split(":")
        try:
            snapshot = json.loads((self.store.root / "snapshots" / (key + ".json")).read_text())
        except FileNotFoundError:
            raise ContentError("invalid_cursor", "Continuation is unavailable; repeat the search", 400) from None
        if snapshot["binding"] != binding:
            raise ContentError("invalid_cursor", "Continuation does not belong to this request", 400)
        for generation in snapshot["data"].get("generations", [snapshot["data"]["generation"]]):
            self.store.manifest(generation)
        return key, int(offset), snapshot["data"]

    def page(self, snapshot, key, offset, field, budget):
        rows = snapshot[field]
        if offset > len(rows):
            raise ContentError("invalid_cursor", "Continuation offset exceeds result set", 400)
        result = {k: v for k, v in snapshot.items() if k != field}
        selected = []
        end = min(len(rows), offset + self.profile.page_size)
        for row in rows[offset:end]:
            trial = {**result, field: selected + [row], "cursor": self.cursor(key, end) if end < len(rows) else None}
            if self.tokenizer.count(json.dumps(trial, ensure_ascii=False)) > budget:
                if selected:
                    end = offset + len(selected)
                    break
                row = {**row, "excerpt": "", "complete": False, "flags": row.get("flags", []) + ["text_omitted_budget"]}
                trial = {**result, field: [row], "cursor": self.cursor(key, offset + 1) if offset + 1 < len(rows) else None}
                if self.tokenizer.count(json.dumps(trial, ensure_ascii=False)) > budget:
                    raise ContentError("profile_budget_invalid", "Evidence metadata exceeds configured token budget")
                selected.append(row)
                end = offset + 1
                break
            selected.append(row)
        return {**result, field: selected, "cursor": self.cursor(key, end) if end < len(rows) else None}

    async def search(self, request: SearchRequest):
        query = request.query.strip()
        if not query or len(query) > self.profile.query_max_chars:
            raise ContentError("invalid_request", "Query is empty or exceeds the configured limit", 400)
        if request.require_qualified and not self.profile.qualified:
            raise ContentError("profile_unqualified", "No qualified retrieval profile is installed")
        binding = digest(["search", query, request.document_id, request.require_qualified, self.profile.fingerprint])
        if request.cursor:
            key, offset, snapshot = self.resume(request.cursor, binding)
        else:
            pool = await self.candidates(query, request.document_id)
            generation, rows, degradation = pool["generation"], pool["rows"], pool["degradation"]
            if self.profile.ranking == "reranker":
                candidates = rows[:self.profile.reranker_depth]
                try:
                    if self.reranker is None:
                        raise ValueError("reranker unavailable")
                    scores = await self.reranker.rank(query, [pool["passages"][r["passage_id"]] for r in candidates])
                    rows = sorted(candidates, key=lambda row: (-scores[row["passage_id"]], -row["score"], row["passage_id"]))
                except Exception as exc:
                    self.record_failure("reranker", generation, exc)
                    degradation.append("reranker_unavailable")
            if degradation and request.require_qualified:
                raise ContentError("qualified_profile_unavailable", "Required retrieval stages failed")
            snapshot = {**self.base(generation, degradation), "generations": pool.get("generations", [generation]),
                "hits": [self.hit(generation, pool["passages"][row["passage_id"]]) for row in rows]}
            key, offset = self.save_snapshot(snapshot, binding), 0
        return self.page(snapshot, key, offset, "hits", self.profile.response_tokens)

    async def read(self, request: ReadRequest):
        binding = digest(["read", request.document_id, request.passage_id, self.profile.fingerprint])
        if request.cursor:
            key, offset, snapshot = self.resume(request.cursor, binding)
        else:
            if request.passage_id:
                match = HANDLE.fullmatch(request.passage_id)
                if not match:
                    raise ContentError("invalid_handle", "Malformed passage handle", 400)
                generation = match[1]
                selected = self.store.passage(generation, request.passage_id)
                if selected.document_id != request.document_id:
                    raise ContentError("invalid_handle", "Passage belongs to another document", 400)
            else:
                generation = None
                for candidate in self.store.active_generations():
                    try:
                        self.store.document(candidate, request.document_id)
                        generation = candidate
                        break
                    except ContentError as error:
                        if error.code not in {"unknown_document", "source_excluded"}:
                            raise
                if generation is None:
                    raise ContentError("unknown_document", "Document is outside the active library", 404)
                selected = None
            doc = self.store.document(generation, request.document_id)
            passages = list(self.store.passages(generation, doc.document_id))
            if selected:
                # Direct expansion starts one source neighbor earlier and can continue to the end.
                passages = [selected, *passages] if selected.kind == "article_lead" else passages[max(0, selected.ordinal - 1):]
            hits = [self.hit(generation, p, omit=selected is None) for p in passages]
            snapshot = {**self.base(generation), "document": {"document_id": doc.document_id, "title": doc.title,
                "edition": doc.edition, "publisher": doc.publisher, "language": doc.language,
                "source_revision": doc.sha256, "license": doc.license, "rights_exceptions": doc.rights_exceptions},
                "overview": selected is None, "passages": hits}
            key, offset = self.save_snapshot(snapshot, binding), 0
        return self.page(snapshot, key, offset, "passages", self.profile.read_tokens)
