import asyncio
import hashlib
import json
import os
import threading
import time
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
    def __init__(self, window=None):
        self.points = {}
        self.fail = False
        self.puts = 0
        self.queries = []
        # The encoder refuses input past its window; a caller fits what it sends.
        self.window = window
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
        self.queries.append(query)
        if self.fail:
            raise RuntimeError("dense unavailable")
        if self.window is not None and Tokens().count(query) > self.window:
            raise ValueError("embedding input exceeds tokenizer window")
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
    retention = {key: changes.pop(key) for key in
                 ("snapshot_ttl", "snapshot_max_bytes", "failure_log_max_bytes") if key in changes}
    p = profile(**changes)
    store, dense = Store(tmp_path / "state"), Dense(p.encoder_max_tokens)
    doc = document(tmp_path)
    generation = asyncio.run(build(store, [doc], p, dense, Tokens(), validation(doc)))
    return Service(store, p, dense, Tokens(), **retention), doc, generation


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


def test_overlong_query_truncates_only_the_dense_branch(tmp_path):
    """A query past the encoder window narrows dense retrieval instead of losing it.

    The window belongs to the sentence encoder alone, so the lexical branch
    searches the whole query; the response reports the narrower dense
    contribution rather than presenting it as full coverage.
    """
    service, _, _ = setup(tmp_path, query_max_chars=4000)
    window = service.profile.encoder_max_tokens
    query = "paraphrase stopcock " * (window + 10)
    lexical_queries = []
    original = service.lexical
    async def capture(generation, value, document_id):
        lexical_queries.append(value)
        return await original(generation, value, document_id)
    service.lexical = capture

    result = asyncio.run(service.search(SearchRequest(query=query.strip())))

    assert result["status"] == "degraded" and "dense_query_truncated" in result["degradation"]
    assert result["hits"], "a truncated dense query still returns evidence"
    assert lexical_queries == [query.strip()], "the lexical branch reads the whole query"
    encoded = service.dense.queries[-1]
    assert Tokens().count(encoded) <= window and query.startswith(encoded)
    assert encoded, "the fitted query keeps as much of the original as the window holds"


def test_overlong_query_records_no_diagnostic_failure(tmp_path):
    """The diagnostic store holds faults, and an over-long query is not one.

    Request traffic would otherwise fill a fixed disk allotment with records of
    ordinary input and push genuine faults out of it.
    """
    service, _, _ = setup(tmp_path, query_max_chars=4000)
    query = "paraphrase stopcock " * (service.profile.encoder_max_tokens + 10)
    asyncio.run(service.search(SearchRequest(query=query.strip())))
    assert failure_rows(service) == []


def test_query_within_the_encoder_window_is_encoded_whole(tmp_path):
    service, _, _ = setup(tmp_path)
    result = asyncio.run(service.search(SearchRequest(query="ZX-42 stopcock")))
    assert service.dense.queries[-1] == "ZX-42 stopcock"
    assert "dense_query_truncated" not in result["degradation"]


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


def test_source_is_named_by_its_title_and_displayed_when_renderable(tmp_path):
    service, doc, generation = setup(tmp_path)
    handle = next(service.store.passages(generation)).passage_id
    async def check():
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=create_app(service)), base_url="http://test") as client:
            header = (await client.get("/v1/corpus/source/" + handle)).headers["content-disposition"]
            # A content-addressed handle identifies the passage; it never names the file.
            assert handle not in header
            assert header.startswith("inline; ")
            assert 'filename="Fixture manual.txt"' in header
    asyncio.run(check())


def test_source_of_an_unrenderable_type_is_saved_under_a_typed_name(tmp_path):
    from oracle_content.app import disposition, source_filename
    doc = document(tmp_path).model_copy(update={"media_type": "application/epub+zip", "title": "Frédéric’s / manual"})
    name = source_filename(doc, doc.media_type)
    header = disposition(doc.media_type, name)
    assert name == "Frédérics manual.epub"
    assert header.startswith("attachment; ")
    assert 'filename="Frederics manual.epub"' in header
    assert "filename*=UTF-8''Fr%C3%A9d%C3%A9rics%20manual.epub" in header


def test_source_filename_falls_back_to_document_identity_when_a_title_has_no_name(tmp_path):
    from oracle_content.app import source_filename
    doc = document(tmp_path).model_copy(update={"title": "///"})
    assert source_filename(doc, "text/plain") == doc.document_id + ".txt"


def test_hits_carry_the_collection_a_document_belongs_to(tmp_path):
    p, store, dense = profile(), Store(tmp_path / "state"), Dense()
    doc = document(tmp_path).model_copy(update={"publisher": "Field Engineering Series"})
    generation = asyncio.run(build(store, [doc], p, dense, Tokens(), validation(doc)))
    service = Service(store, p, dense, Tokens())
    result = asyncio.run(service.search(SearchRequest(query="ZX-42")))
    assert result["hits"] and all(h["collection"] == "Field Engineering Series" for h in result["hits"])
    snapshot = asyncio.run(service.read(ReadRequest(document_id=doc.document_id)))
    assert snapshot["document"]["collection"] == "Field Engineering Series"


def test_collection_is_empty_when_it_would_only_repeat_the_title(tmp_path):
    p, store, dense = profile(), Store(tmp_path / "state"), Dense()
    doc = document(tmp_path).model_copy(update={"publisher": "fixture MANUAL"})
    generation = asyncio.run(build(store, [doc], p, dense, Tokens(), validation(doc)))
    result = asyncio.run(Service(store, p, dense, Tokens()).search(SearchRequest(query="ZX-42")))
    assert result["hits"] and all(h["collection"] == "" for h in result["hits"])


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


def snapshot_files(service):
    return sorted((service.store.root / "snapshots").glob("*.json"))


def test_expired_continuations_are_reclaimed_without_losing_live_ones(tmp_path):
    service, _, _ = setup(tmp_path, snapshot_ttl=60, page_size=1)
    first = asyncio.run(service.search(SearchRequest(query="ZX-42")))
    assert first["cursor"]
    assert len(snapshot_files(service)) == 1
    aged = snapshot_files(service)[0]
    os.utime(aged, (time.time() - 3600, time.time() - 3600))
    # Residue of an interrupted atomic write has no reader at any age.
    fresh_residue = service.store.root / "snapshots" / "pending.json.abc.tmp"
    fresh_residue.write_text("{}")
    old_residue = service.store.root / "snapshots" / "abandoned.json.def.tmp"
    old_residue.write_text("{}")
    os.utime(old_residue, (time.time() - 3600, time.time() - 3600))
    service.snapshot_pruned_at = None
    asyncio.run(service.search(SearchRequest(query="stopcock")))
    assert not aged.exists()
    assert not old_residue.exists() and fresh_residue.exists()
    assert len(snapshot_files(service)) == 1
    # An expired continuation reports itself rather than resolving to another result set.
    with pytest.raises(ContentError) as expired:
        asyncio.run(service.search(SearchRequest(query="ZX-42", cursor=first["cursor"])))
    assert expired.value.code == "invalid_cursor"


def test_snapshot_storage_stays_under_its_ceiling(tmp_path):
    service, _, _ = setup(tmp_path, snapshot_max_bytes=8000)
    # A burst never reaches the scan interval, so only the byte counter can hold
    # the ceiling; the written total here is several times the cap.
    for _ in range(24):
        asyncio.run(service.search(SearchRequest(query="ZX-42 stopcock seal")))
    assert sum(path.stat().st_size for path in snapshot_files(service)) <= 2 * 8000
    service.prune_snapshots(force=True)
    files = snapshot_files(service)
    assert sum(path.stat().st_size for path in files) <= 8000
    assert files, "the newest continuation survives eviction of the oldest"


def failure_files(service):
    return [path for path in (service.store.root / "failures.jsonl",
                              service.store.root / "failures.1.jsonl") if path.exists()]


def failure_rows(service):
    # Oldest first: the rotated predecessor precedes the live file.
    rows = []
    for name in ("failures.1.jsonl", "failures.jsonl"):
        path = service.store.root / name
        if path.exists():
            rows.extend(json.loads(line) for line in path.read_text().splitlines())
    return rows


def test_failure_store_stays_within_its_allotment(tmp_path):
    service, _, generation = setup(tmp_path, failure_log_max_bytes=4000)
    # Distinct mechanisms, so the written volume is not reduced by folding and
    # only the allotment can hold it; the total attempted is many times the cap.
    for index in range(400):
        try:
            raise RuntimeError("stage failed")
        except RuntimeError as error:
            service.record_failure(f"probe-{index}", generation, error)
    assert sum(path.stat().st_size for path in failure_files(service)) <= 4000
    rows = failure_rows(service)
    assert rows, "recording continues across rotation"
    assert rows[-1]["stage"] == "probe-399", "the newest failure is the one retained"
    assert len(failure_files(service)) == 2 and len(rows) > 1, (
        "rotation retains a predecessor, so a burst cannot erase the whole store at once")
    assert rows[-1]["traceback"], "a retained record keeps its full mechanism evidence"


def test_repeated_identical_failure_folds_by_fingerprint(tmp_path):
    service, _, _ = setup(tmp_path)
    service.dense.fail = True
    for _ in range(16):
        result = asyncio.run(service.search(SearchRequest(query="ZX-42")))
        assert result["degradation"] == ["dense_unavailable"], "recording never alters the response"
    rows = failure_rows(service)
    assert [row["count"] for row in rows] == [1, 2, 4, 8, 16]
    assert len({row["fingerprint"] for row in rows}) == 1
    assert all(row["traceback"] for row in rows)
    # A repeating fault never buries a different one behind its own volume.
    try:
        raise ValueError("another mechanism")
    except ValueError as error:
        service.record_failure("reranker", None, error)
    assert failure_rows(service)[-1]["type"] == "ValueError"


def test_uncached_source_reading_leaves_the_event_loop_free(tmp_path):
    service, doc, _ = setup(tmp_path)
    started = threading.Event()
    release = threading.Event()
    original = service.store.passages
    def slow(*args, **kwargs):
        started.set()
        assert release.wait(5)
        return original(*args, **kwargs)
    service.store.passages = slow
    async def check():
        reading = asyncio.create_task(service.read(ReadRequest(document_id=doc.document_id)))
        await asyncio.to_thread(started.wait, 5)
        # The loop is still scheduling while the blocking read is in flight.
        ticks = 0
        for _ in range(5):
            await asyncio.sleep(0)
            ticks += 1
        release.set()
        assert ticks == 5
        return await reading
    result = asyncio.run(check())
    assert result["passages"]


def test_dense_hit_resolution_leaves_the_event_loop_free(tmp_path):
    service, _, _ = setup(tmp_path)
    started, release = threading.Event(), threading.Event()
    original = service.store.passage
    def slow(*args, **kwargs):
        started.set()
        assert release.wait(5)
        return original(*args, **kwargs)
    service.store.passage = slow
    async def check():
        searching = asyncio.create_task(service.search(SearchRequest(query="paraphrase")))
        await asyncio.to_thread(started.wait, 5)
        ticks = 0
        for _ in range(5):
            await asyncio.sleep(0)
            ticks += 1
        release.set()
        assert ticks == 5
        return await searching
    assert asyncio.run(check())["hits"]


def categorized(tmp_path, service, category):
    """Stage two works of one pack under a named category of the active library."""
    works = [document(tmp_path, name="psalms", text="A psalm of ascents.\n\nAnother paraphrase line.").model_copy(
                 update={"pack_id": "canon", "title": "Psalms", "publisher": "Translators"}),
             document(tmp_path, name="gita", text="A verse of the field.\n\nAnother paraphrase line.").model_copy(
                 update={"pack_id": "canon", "title": "Bhagavad Gita", "publisher": "Translators"})]
    evidence = {}
    for work in works:
        evidence.update(validation(work))
    return asyncio.run(build(service.store, works, service.profile, service.dense, Tokens(), evidence, category=category))


def test_library_listing_groups_installed_works_under_their_category(tmp_path):
    service, _, generation = setup(tmp_path)
    categorized(tmp_path, service, "Scripture and canon")

    listing = service.collections()

    assert listing["generation"] and listing["profile_id"] == service.profile.profile_id
    by_title = {entry["title"]: entry for entry in listing["collections"]}
    assert by_title["fixture"]["category"] == "", "a pack prepared without a category is listed on its own"
    assert by_title["canon"]["category"] == "Scripture and canon"
    assert by_title["canon"]["works"] == ["Psalms", "Bhagavad Gita"]
    assert by_title["canon"]["additional_works"] == 0
    assert by_title["canon"]["publisher"] == "Translators"


def test_renaming_a_category_relists_the_same_generation(tmp_path):
    service, _, _ = setup(tmp_path)
    first = categorized(tmp_path, service, "Scripture and canon")

    again = categorized(tmp_path, service, "Practical reference")

    assert again == first, "a category describes the installation, so renaming one rebuilds nothing"
    entry = next(e for e in service.collections()["collections"] if e["title"] == "canon")
    assert entry["category"] == "Practical reference"


def test_listing_counts_the_works_it_does_not_name(tmp_path):
    service, _, _ = setup(tmp_path)
    from oracle_content.service import COLLECTION_WORKS_LIMIT
    works, evidence = [], {}
    for index in range(COLLECTION_WORKS_LIMIT + 3):
        work = document(tmp_path, name=f"tract{index}", text=f"Tract {index}.\n\nA paraphrase line.").model_copy(
            update={"pack_id": "tracts", "title": f"Tract {index}"})
        works.append(work)
        evidence.update(validation(work))
    asyncio.run(build(service.store, works, service.profile, service.dense, Tokens(), evidence, category="Scripture and canon"))

    entry = next(e for e in service.collections()["collections"] if e["title"] == "tracts")

    assert len(entry["works"]) == COLLECTION_WORKS_LIMIT
    assert entry["additional_works"] == 3


def test_http_listing_reports_the_installed_library(tmp_path):
    service, _, _ = setup(tmp_path)
    categorized(tmp_path, service, "Scripture and canon")
    async def check():
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=create_app(service)), base_url="http://test") as client:
            response = await client.get("/v1/corpus/collections")
            assert response.status_code == 200
            categories = {entry["category"] for entry in response.json()["collections"]}
            assert categories == {"", "Scripture and canon"}
    asyncio.run(check())
