"""Offline answer/arm checks through the configured service; no model-quality claim."""
import asyncio
import hashlib
import json
import math
from types import SimpleNamespace

import httpx
import pytest
from tokenizers import Tokenizer, models, pre_tokenizers

from oracle_content.app import configured_service
from oracle_content.extract import TokenCounter
from oracle_content.ingest import build
from oracle_content.models import SearchRequest
from oracle_content.store import Store, atomic_json
from .test_content import Dense, document, profile, validation


# Original fixture prose, deliberately small and unambiguous. Each collection
# owns one answer; the synonym is absent from the indexed text.
TOPICS = [
    ("copper", "wire", "Copper conducts electric current."),
    ("orchard", "fruit", "An orchard contains cultivated apple trees."),
    ("telescope", "stargazing", "A telescope gathers light from distant stars."),
    ("pottery", "ceramics", "Pottery is shaped from clay and fired in a kiln."),
    ("violin", "fiddle", "A violin produces sound from bowed strings."),
    ("bicycle", "cycling", "A bicycle transmits pedal force through a chain."),
]


def tokenizer_artifact(root, name, characters=False):
    tokenizer = Tokenizer(models.WordLevel({"[UNK]": 0}, unk_token="[UNK]"))
    tokenizer.pre_tokenizer = (pre_tokenizers.Split("", behavior="isolated")
                               if characters else pre_tokenizers.WhitespaceSplit())
    path = root / (name + ".json")
    tokenizer.save(str(path))
    return str(path), hashlib.sha256(path.read_bytes()).hexdigest()


def vector(text, *, query=False):
    words = text.lower().split()
    values = [1.0 if topic in words or synonym in words else 0.0
              for topic, synonym, _ in TOPICS]
    # Identifier passages deliberately sit outside each collection's dense top-1.
    return values if any(values) else [1.0 if query else -1.0] * len(TOPICS)


def cosine(left, right):
    return sum(a * b for a, b in zip(left, right)) / math.sqrt(
        sum(a * a for a in left) * sum(b * b for b in right))


@pytest.fixture(scope="module")
def library(tmp_path_factory):
    tmp_path = tmp_path_factory.mktemp("retrieval-sanity")
    monkeypatch = pytest.MonkeyPatch()
    encoder_path, encoder_hash = tokenizer_artifact(tmp_path, "encoder", characters=True)
    chat_path, chat_hash = tokenizer_artifact(tmp_path, "chat")
    p = profile(encoder_dimensions=len(TOPICS), encoder_max_tokens=160,
                encoder_tokenizer=encoder_path, encoder_tokenizer_sha256=encoder_hash,
                chat_tokenizer=chat_path, chat_tokenizer_sha256=chat_hash,
                query_prefix="query: ", query_max_chars=2000, dense_depth=1,
                response_tokens=1200, page_size=2)
    encoder = TokenCounter(encoder_path, encoder_hash)
    store, indexed = Store(tmp_path / "state"), Dense()
    generations, documents = [], []
    for index, (topic, _synonym, prose) in enumerate(TOPICS):
        doc = document(tmp_path, name=topic,
                       text=f"Guide {topic}: {prose}\n\nIdentifier ZX-{40 + index} has inspection code {index}.")
        doc = doc.model_copy(update={"pack_id": topic, "publisher": topic, "title": f"{topic} guide"})
        generations.append(asyncio.run(build(store, [doc], p, indexed, encoder, validation(doc))))
        documents.append(doc)
    profile_path = tmp_path / "profile.json"
    profile_path.write_text(p.model_dump_json())
    monkeypatch.setenv("CONTENT_STATE_DIR", str(store.root))
    monkeypatch.setenv("CONTENT_PROFILE", str(profile_path))
    monkeypatch.setenv("CONTENT_EMBED_URL", "http://encoder.test")
    monkeypatch.setenv("CONTENT_QDRANT_URL", "http://vectors.test")
    encoded, searches = [], []

    def transport(request):
        if request.url.path == "/info":
            return httpx.Response(200, json={"model_id": p.encoder_id, "model_sha": p.encoder_revision})
        body = json.loads(request.content)
        if request.url.path == "/embed":
            assert body["truncate"] is False
            encoded.extend(body["inputs"])
            assert all(encoder.count(text) <= p.encoder_max_tokens for text in body["inputs"])
            return httpx.Response(200, json=[vector(text, query=True) for text in body["inputs"]])
        assert request.url.path.endswith("/points/query"), request.url
        generation = request.url.path.split("corpus_")[1].split("/")[0]
        searches.append(generation)
        conditions = {item["key"]: item["match"]["value"] for item in body["filter"]["must"]}
        assert conditions["generation"] == generation
        assert conditions["encoder"] == p.index_fingerprint
        points = [{"score": cosine(body["query"], vector(passage.text)),
                   "payload": {"generation": generation, "encoder": p.index_fingerprint,
                               "passage_id": passage.passage_id, "document_id": passage.document_id}}
                  for passage in indexed.points[generation].values()
                  if conditions.get("document_id", passage.document_id) == passage.document_id]
        points.sort(key=lambda point: -point["score"])
        return httpx.Response(200, json={"result": {"points": points[:body["limit"]]}})

    client = httpx.AsyncClient(transport=httpx.MockTransport(transport))
    try:
        service = configured_service(client)
    finally:
        monkeypatch.undo()
    yield SimpleNamespace(service=service, generations=generations, documents=documents,
                          encoded=encoded, searches=searches, encoder=encoder)
    asyncio.run(client.aclose())


def search(library, query, **kwargs):
    return asyncio.run(library.service.search(SearchRequest(query=query, **kwargs)))


@pytest.mark.parametrize("reverse", [False, True], ids=["forward", "reverse"])
@pytest.mark.parametrize("mixed_scores", [False, True], ids=["sqlite", "mixed-lexical-scales"])
def test_every_collection_can_supply_the_first_answer(library, reverse, mixed_scores, monkeypatch):
    generations = library.generations[::-1] if reverse else library.generations
    atomic_json(library.service.store.root / "active.json",
                {"generation": generations[0], "additional_generations": generations[1:]})
    if mixed_scores:
        lexical = library.service.lexical
        async def rescaled(generation, query, document_id):
            rows = await lexical(generation, query, document_id)
            if library.generations.index(generation) % 2:
                # Native nested-RRF scores are positive; SQLite BM25 is negative.
                # Preserve each arm's ordering while changing its unrelated scale.
                return [(pid, 1 / (60 + rank)) for rank, (pid, _score) in enumerate(rows, 1)]
            return rows
        monkeypatch.setattr(library.service, "lexical", rescaled)
    winners = set()
    for topic, _synonym, prose in TOPICS:
        result = search(library, f"{topic} guide")
        assert result["degradation"] == []
        assert result["hits"][0]["document_id"] == topic, f"collection starved: {topic}"
        assert prose in result["hits"][0]["excerpt"]
        winners.add(result["hits"][0]["document_id"])
    assert winners == {topic for topic, *_ in TOPICS}


def test_each_arm_contributes_an_answer_the_other_misses(library):
    service = library.service
    semantic = asyncio.run(service.candidates("stargazing"))
    assert semantic["branches"]["lexical"] == []
    assert semantic["branches"]["dense"]
    result = search(library, "stargazing")
    assert result["degradation"] == []
    assert result["hits"][0]["document_id"] == "telescope"
    assert TOPICS[2][2] in result["hits"][0]["excerpt"]

    lexical = asyncio.run(service.candidates("ZX-45"))
    wanted = {pid for pid, _ in lexical["branches"]["lexical"]}
    assert wanted and wanted.isdisjoint(pid for pid, _ in lexical["branches"]["dense"])
    result = search(library, "ZX-45")
    assert result["degradation"] == []
    assert any("ZX-45" in hit["excerpt"] for hit in result["hits"])


def test_long_query_keeps_semantic_answer_with_distinct_tokenizers(library):
    query = "stargazing " + "please " * 90 + "ZX-45"
    service = library.service
    assert service.tokenizer.count(service.profile.query_prefix + query) < service.profile.encoder_max_tokens
    assert library.encoder.count(service.profile.query_prefix + query) > service.profile.encoder_max_tokens
    result = search(library, query)
    assert result["degradation"] == ["dense_query_truncated"]
    assert any(TOPICS[2][2] in hit["excerpt"] for hit in result["hits"]), "semantic answer disappeared"
    assert library.encoded and all(library.encoder.count(text) <= service.profile.encoder_max_tokens
                                   for text in library.encoded)
    # The trailing exact identifier survives in the lexical arm despite dense truncation.
    assert any("ZX-45" in hit["excerpt"] for hit in result["hits"])


def test_pages_preserve_ranked_evidence_scope_and_budget(library):
    service = library.service
    query = "guide"
    result = search(library, query)
    total, seen = result["result_set"]["total"], []
    assert total == 2 * len(TOPICS)
    assert len(result["result_set"]["collections"]) == len(TOPICS)
    calls = len(library.searches)
    while True:
        assert result["result_set"]["offset"] == len(seen)
        assert result["result_set"]["total"] == total
        assert service.tokenizer.count(json.dumps(result, ensure_ascii=False)) <= service.profile.response_tokens
        for hit in result["hits"]:
            passage = service.store.passage(hit["passage_id"].split(":")[1], hit["passage_id"])
            assert hit["excerpt"] == passage.text
            seen.append(hit["passage_id"])
        if not result["cursor"]:
            break
        result = search(library, query, cursor=result["cursor"])
    assert len(seen) == len(set(seen)) == total
    assert len(library.searches) == calls, "continuations must reuse the frozen ranking"
    scoped = search(library, "stargazing", document_id="telescope")
    assert {hit["document_id"] for hit in scoped["hits"]} == {"telescope"}
