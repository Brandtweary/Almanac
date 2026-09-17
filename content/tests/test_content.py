import asyncio
import hashlib
import json
from pathlib import Path
import pytest
import httpx
from oracle_content.models import Block, ContentError, Document, Profile, SearchRequest, ReadRequest
from oracle_content.extract import html_blocks, segment
from oracle_content.ingest import build
from oracle_content.store import Store, atomic_json
from oracle_content.service import Service, fuse, remove_contained
from oracle_content.adapters import Qdrant, Reranker, vectors_valid
from oracle_content.app import create_app


class Tokens:
    def count(self, text):
        return len(text.split())
    def pair_count(self, query, text):
        return self.count(query + " " + text)


class Dense:
    def __init__(self):
        self.points = {}
        self.fail = False
        self.puts = 0
    async def create(self, generation):
        self.points.setdefault(generation, {})
    async def put(self, generation, passages):
        if self.fail:
            raise RuntimeError("interrupted embedding")
        self.puts += 1
        self.points[generation].update({p.passage_id: p for p in passages})
    async def validate(self, generation, ids):
        assert set(self.points[generation]) == set(ids)
    async def search(self, generation, query, document_id=None):
        if self.fail:
            raise RuntimeError("dense unavailable")
        return [(p.passage_id, 0.9) for p in self.points[generation].values()
                if "paraphrase" in p.text and (not document_id or p.document_id == document_id)]


def profile(**changes):
    values = dict(profile_id="test-unqualified", encoder_id="synthetic", encoder_revision="test", encoder_dimensions=2,
        encoder_tokenizer="unused", encoder_tokenizer_sha256="0" * 64, encoder_max_tokens=50,
        chat_tokenizer="unused", chat_tokenizer_sha256="0" * 64, lexical_depth=10, dense_depth=10,
        rrf_k=60, lexical_weight=1, dense_weight=1, page_size=2, response_tokens=3000, read_tokens=3000,
        query_max_chars=1000, request_timeout=5, embedding_batch=1)
    return Profile(**(values | changes))


def document(tmp_path, name="manual", text="Valve ZX-42 pressure.\n\nA paraphrase about the stopcock.\n\nWarning: do not remove the seal."):
    path = tmp_path / (name + ".txt")
    path.write_text(text)
    return Document(document_id=name, work_id=name, pack_id="fixture", title="Fixture manual", language="en",
        source_url="https://example.org/reference", sha256=hashlib.sha256(path.read_bytes()).hexdigest(),
        media_type="text/plain", license="CC0", extraction_revision="text-v1", original_path=str(path))


def validation(doc):
    return {doc.document_id: dict(sha256=doc.sha256, extraction_revision=doc.extraction_revision, checked=True, receipt="fixture-inspection")}


def setup(tmp_path, **changes):
    store, dense, p = Store(tmp_path / "state"), Dense(), profile(**changes)
    doc = document(tmp_path)
    generation = asyncio.run(build(store, [doc], p, dense, Tokens(), validation(doc)))
    return Service(store, p, dense, Tokens()), doc, generation


def test_independent_union_and_pagination(tmp_path):
    service, doc, generation = setup(tmp_path)
    result = asyncio.run(service.search(SearchRequest(query="ZX-42")))
    assert result["status"] == "unqualified"
    assert {h["excerpt"] for h in result["hits"]} == {"Valve ZX-42 pressure.", "A paraphrase about the stopcock."}
    assert all(h["source_revision"] == doc.sha256 for h in result["hits"])
    assert result["generation"] == generation


def test_rrf_duplicate_ids_do_not_inflate_ranks():
    rows = fuse({"lexical": [("a", 1), ("a", 1), ("b", 0)], "dense": [("c", 1)]}, {"lexical": 1, "dense": 1}, 60)
    assert next(r for r in rows if r["passage_id"] == "b")["ranks"]["lexical"] == 2
    assert len(rows) == 3
    assert next(r for r in rows if r["passage_id"] == "a")["score"] == 1 / 61


def test_lexical_syntax_is_literal_and_numeric_identifier_survives(tmp_path):
    service, _, generation = setup(tmp_path)
    assert service.store.lexical(generation, 'ZX-42 " OR * - )', 10)
    assert service.store.lexical(generation, '" ) *', 10) == []


def test_dense_failure_label_and_required_profile(tmp_path):
    service, _, _ = setup(tmp_path)
    service.dense.fail = True
    result = asyncio.run(service.search(SearchRequest(query="ZX-42")))
    assert result["status"] == "degraded" and result["degradation"] == ["dense_unavailable"]
    assert len(result["hits"]) == 1
    with pytest.raises(ContentError, match="qualified"):
        asyncio.run(service.search(SearchRequest(query="ZX", require_qualified=True)))


def test_lexical_failure_never_returns_dense_only(tmp_path, monkeypatch):
    service, _, _ = setup(tmp_path)
    def broken(*args):
        raise RuntimeError("index corrupt")
    monkeypatch.setattr(service.store, "lexical", broken)
    with pytest.raises(ContentError) as error:
        asyncio.run(service.search(SearchRequest(query="ZX")))
    assert error.value.code == "lexical_unavailable"


def test_old_handles_survive_new_generation_and_cursor_is_bound(tmp_path):
    service, doc, old = setup(tmp_path, page_size=1)
    result = asyncio.run(service.search(SearchRequest(query="ZX-42")))
    handle = result["hits"][0]["passage_id"]
    newer = document(tmp_path, "new", "Different content.")
    new = asyncio.run(build(service.store, [newer], service.profile, service.dense, Tokens(), validation(newer)))
    assert new != old
    read = asyncio.run(service.read(ReadRequest(document_id=doc.document_id, passage_id=handle)))
    assert read["generation"] == old
    continued = asyncio.run(service.search(SearchRequest(query="ZX-42", cursor=result["cursor"])))
    assert continued["generation"] == old
    with pytest.raises(ContentError) as error:
        asyncio.run(service.search(SearchRequest(query="other", cursor=result["cursor"])))
    assert error.value.code == "invalid_cursor"


def test_resume_failed_stage_does_not_activate_partial(tmp_path):
    service, doc, active = setup(tmp_path)
    newer = document(tmp_path, "new", "Another source.")
    service.dense.fail = True
    with pytest.raises(RuntimeError):
        asyncio.run(build(service.store, [newer], service.profile, service.dense, Tokens(), validation(newer)))
    assert service.store.active() == active
    manifests = [json.loads(p.read_text()) for p in (service.store.root / "generations").glob("*/manifest.json")]
    failed = next(m for m in manifests if "failure" in m)
    assert failed["stage"] == "lexical-indexed"
    service.dense.fail = False
    new = asyncio.run(build(service.store, [newer], service.profile, service.dense, Tokens(), validation(newer)))
    assert new == service.store.active() != active
    puts = service.dense.puts
    asyncio.run(build(service.store, [newer], service.profile, service.dense, Tokens(), validation(newer)))
    assert service.dense.puts == puts


def test_extraction_inspection_required_and_checksum_checked(tmp_path):
    doc, p, dense, store = document(tmp_path), profile(), Dense(), Store(tmp_path / "state")
    with pytest.raises(ValueError, match="inspection"):
        asyncio.run(build(store, [doc], p, dense, Tokens(), {}))
    with pytest.raises(ContentError):
        store.active()
    Path(doc.original_path).write_text("altered")
    with pytest.raises(ValueError, match="checksum"):
        asyncio.run(build(store, [doc], p, dense, Tokens(), validation(doc)))


def test_table_headers_and_units_preserved_and_large_table_readable(tmp_path):
    blocks = html_blocks('<h1>Pressure</h1><table><caption>Gauge</caption><tr><th>Model</th><th>kPa</th></tr><tr><td>ZX-42</td><td>20</td></tr></table>')
    assert blocks[1].text == "Gauge\nModel | kPa\nZX-42 | 20"
    doc = document(tmp_path)
    passages = segment(doc, [Block(text="Header kPa\n" + "42 20\n" * 80, kind="table")], profile(), Tokens(), "a" * 64)
    assert "table_exceeds_encoder_window" in passages[0].flags
    assert "Header kPa" in passages[0].text and len(passages[0].text) > len(passages[0].embedding_text)


def test_segmentation_preserves_every_character_and_token_window(tmp_path):
    doc = document(tmp_path)
    text = "First instruction. " * 100 + "Critical warning."
    p = profile(encoder_max_tokens=15)
    passages = segment(doc, [Block(text=text)], p, Tokens(), "a" * 64)
    assert "".join(x.text for x in passages) == text
    assert all(Tokens().count(x.embedding_text) <= 15 for x in passages)


def test_overlap_preserves_unique_tail_and_editions(tmp_path):
    doc = document(tmp_path)
    p = segment(doc, [Block(text="abcdefghij")], profile(), Tokens(), "a" * 64)[0]
    q = p.model_copy(update=dict(passage_id="q", start=2, end=5, text="cde"))
    r = p.model_copy(update=dict(passage_id="r", start=8, end=15, text="ijWARN!"))
    s = q.model_copy(update=dict(passage_id="s", source_revision="b" * 64))
    rows = [{"passage_id": x.passage_id} for x in [p,q,r,s]]
    kept = remove_contained(rows, {x.passage_id:x for x in [p,q,r,s]})
    assert {x["passage_id"] for x in kept} == {p.passage_id, "r", "s"}


def test_read_rejects_wrong_document_and_unknown_version(tmp_path):
    service, _, generation = setup(tmp_path)
    handle = next(service.store.passages(generation)).passage_id
    with pytest.raises(ContentError, match="another document"):
        asyncio.run(service.read(ReadRequest(document_id="other", passage_id=handle)))
    with pytest.raises(ContentError) as error:
        asyncio.run(service.read(ReadRequest(document_id="manual", passage_id="p:" + "b" * 64 + ":" + "c" * 64)))
    assert error.value.status == 410


def test_vector_validation_rejects_cardinality_nan_zero():
    for vectors in ([], [[float("nan"), 1]], [[0, 0]], [[1]], [[True, 1]]):
        with pytest.raises(ValueError):
            vectors_valid(vectors, 1, 2)


def test_http_schema_health_and_invalid_inputs(tmp_path):
    service, _, _ = setup(tmp_path)
    async def check():
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=create_app(service)), base_url="http://test") as client:
            assert (await client.get("/health")).json()["ready"] is True
            response = await client.post("/v1/corpus/search", json={"query":"ZX-42"})
            assert response.status_code == 200 and response.json()["hits"]
            assert (await client.post("/v1/corpus/search", json={"query":"x", "path":"/etc/passwd"})).status_code == 400
            assert (await client.get("/v1/corpus/source/bad")).status_code == 400
    asyncio.run(check())


def test_adapter_qualification_streamed_documents_and_hardlink(tmp_path):
    doc, p, dense, store = document(tmp_path), profile(), Dense(), Store(tmp_path / "state")
    evidence = {"adapters": {"text/plain:text-v1": {"checked": True, "receipt": "representative-fixtures"}}}
    generation = asyncio.run(build(store, iter([doc]), p, dense, Tokens(), evidence, managed_originals=True))
    stored = store.document(generation, doc.document_id)
    assert (store.root / stored.original_path).stat().st_ino == Path(doc.original_path).stat().st_ino
    assert not Path(stored.original_path).is_absolute()


def test_source_original_is_independent_of_changed_acquisition_path(tmp_path):
    service, doc, generation = setup(tmp_path)
    handle = next(service.store.passages(generation)).passage_id
    Path(doc.original_path).write_text("replacement bytes")
    async def check():
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=create_app(service)), base_url="http://test") as client:
            response = await client.get("/v1/corpus/source/" + handle)
            assert response.status_code == 200 and "Valve ZX-42" in response.text
    asyncio.run(check())


def test_failed_document_extraction_has_durable_status(tmp_path):
    doc = document(tmp_path, text="")
    store = Store(tmp_path / "state")
    with pytest.raises(ValueError, match="extractions failed"):
        asyncio.run(build(store, [doc], profile(), Dense(), Tokens(), validation(doc)))
    import sqlite3
    receipt = next((store.root / "generations").glob("*/extraction.sqlite"))
    with sqlite3.connect(receipt) as db:
        status, error = db.execute("SELECT status,error FROM extracted").fetchone()
    assert status == "failed" and "empty extraction" in error


def test_reranker_misaligned_duplicate_indices_fail():
    p = profile(ranking="reranker", reranker_id="fixture", reranker_revision="test", reranker_tokenizer="unused",
                reranker_tokenizer_sha256="0" * 64, reranker_max_tokens=100, reranker_depth=2, reranker_batch=2)
    class Candidate:
        embedding_text = "source"
        passage_id = "a"
    def respond(request):
        data = {"model_id":"fixture", "model_sha":"test"} if request.method == "GET" else [{"index":0,"score":0.1},{"index":0,"score":0.2}]
        return httpx.Response(200, json=data)
    async def check():
        async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as client:
            ranker = Reranker(client, "http://local", p, Tokens())
            with pytest.raises(ValueError, match="ID/score"):
                await ranker.rank("query", [Candidate(), Candidate()])
    asyncio.run(check())


def test_qdrant_rejects_wrong_encoder_and_validates_every_vector(tmp_path):
    service, _, generation = setup(tmp_path)
    p = service.profile
    ids = {x.passage_id for x in service.store.passages(generation)}
    def respond(request):
        if request.method == "GET":
            result = {"config":{"params":{"vectors":{"size":2,"distance":"Cosine"}}}}
        elif request.url.path.endswith("count"):
            result = {"count":len(ids)}
        else:
            result = {"points":[{"id":"bad", "payload":{"generation":generation,"encoder":"other"}}], "next_page_offset":None}
        return httpx.Response(200,json={"result":result})
    async def check():
        async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as client:
            adapter = Qdrant(client,"http://local",None,p)
            with pytest.raises(ValueError,match="encoder mismatch"):
                await adapter.validate(generation,ids)
    asyncio.run(check())


def test_encoder_change_reuses_extraction_not_old_vectors(tmp_path, monkeypatch):
    service, doc, old = setup(tmp_path)
    def broken(*args, **kwargs):
        raise AssertionError("unchanged source was extracted twice")
    monkeypatch.setattr("oracle_content.ingest.extract", broken)
    changed = profile(encoder_revision="new-encoder")
    before = service.dense.puts
    newer = asyncio.run(build(service.store,[doc],changed,service.dense,Tokens(),validation(doc)))
    assert newer != old and service.dense.puts > before


def test_ranking_and_qualification_change_reuses_immutable_index(tmp_path):
    service, doc, generation = setup(tmp_path)
    changed = profile(profile_id="qualified-profile", qualified=True, receipts=["heldout-results"],
                      rrf_k=20, lexical_depth=5, dense_depth=6, response_tokens=4000, embedding_batch=3)
    assert changed.fingerprint != service.profile.fingerprint
    assert changed.index_fingerprint == service.profile.index_fingerprint
    before = service.dense.puts
    same = asyncio.run(build(service.store, [doc], changed, service.dense, Tokens(), validation(doc)))
    assert same == generation and service.dense.puts == before
    promoted = Service(service.store, changed, service.dense, Tokens())
    assert promoted.health()["ready"] is True
    response = asyncio.run(promoted.search(SearchRequest(query="ZX42", require_qualified=True)))
    assert response["status"] == "ok" and response["profile_id"] == "qualified-profile"
    incompatible = Service(service.store, profile(encoder_revision="other"), service.dense, Tokens())
    assert incompatible.health()["ready"] is False
    with pytest.raises(ContentError, match="different release profile"):
        asyncio.run(incompatible.search(SearchRequest(query="ZX42")))


def test_table_nested_in_instruction_keeps_structure_and_warning_order():
    blocks = html_blocks('<main><ul><li>Check concentration.<table><tr><th>Volume</th><th>6%</th></tr><tr><td>1 L</td><td>2 drops</td></tr></table><p>Double if cloudy.</p></li></ul></main>')
    assert [b.kind for b in blocks] == ["list_item", "table", "list_item"]
    assert blocks[1].text == "Volume | 6%\n1 L | 2 drops"
    assert blocks[2].text == "Double if cloudy."


def test_oversized_table_is_still_lexically_searchable(tmp_path):
    doc = document(tmp_path)
    p = profile()
    table = segment(doc,[Block(text="UniquePressureZX42 kPa\n" + "100 20\n"*80,kind="table")],p,Tokens(),"a"*64)[0]
    from oracle_content.store import build_catalog
    store=Store(tmp_path/'table-state')
    directory=store.directory('a'*64);directory.mkdir(parents=True)
    build_catalog(directory/'catalog.sqlite',[doc],[table])
    assert store.lexical('a'*64,'UniquePressureZX42',10)[0][0]==table.passage_id


def test_http_deadline_cancels_backend_and_finishes_response(tmp_path):
    service, _, _ = setup(tmp_path, request_timeout=0.03)
    released = []
    async def stalled(*args):
        try:
            await asyncio.sleep(3600)
        finally:
            released.append(True)
    service.dense.search = stalled
    async def check():
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=create_app(service)), base_url="http://test") as client:
            response = await asyncio.wait_for(client.post('/v1/corpus/search',json={'query':'ZX42'}),timeout=1)
            assert response.status_code == 504
            assert response.json()['error']['code'] == 'request_timeout'
    asyncio.run(check())
    assert released == [True]


def test_local_artifact_runtime_path_keeps_portable_index_identity():
    from oracle_content.adapters import Embeddings
    p=profile(encoder_runtime_id='/models/verified-local-snapshot')
    assert p.index_fingerprint == profile().index_fingerprint
    assert p.fingerprint == profile().fingerprint
    def respond(request):
        return httpx.Response(200,json={'model_id':'/models/verified-local-snapshot','model_sha':'test'})
    async def check():
        async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as client:
            await Embeddings(client,'http://local',p,Tokens()).check()
    asyncio.run(check())


def test_html_heading_hierarchy_preserves_levels_when_headings_are_skipped():
    blocks = html_blocks('<main><h2>Water</h2><p>Boil.</p><h3>Storage</h3><p>Seal.</p>'
        '<h2>Food</h2><p>Cook.</p><h4>Grains</h4><p>Dry.</p><h3>Beans</h3><p>Soak.</p></main>')
    assert [(b.text, b.section) for b in blocks if b.kind == 'paragraph'] == [
        ('Boil.', ['Water']), ('Seal.', ['Water', 'Storage']), ('Cook.', ['Food']),
        ('Dry.', ['Food', 'Grains']), ('Soak.', ['Food', 'Beans'])]
