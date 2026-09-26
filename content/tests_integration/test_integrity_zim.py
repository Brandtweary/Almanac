"""Integrity against real ZIM archives: localisation, quarantine, reload and whole-library readiness.

The archives are built locally with libzim and damaged on purpose after admission,
the way `test_pali_canon_zim.py` breaks archives: a guard that has only seen healthy
archives passes whether or not it detects anything.
"""
import asyncio
import hashlib
import json
import os
import random
from pathlib import Path
from types import SimpleNamespace

import httpx
import pytest
from libzim.writer import Creator
from tokenizers import Tokenizer, models, pre_tokenizers

from oracle_content.adapters import ZimLexical
from oracle_content.app import create_app
from oracle_content.extract import TokenCounter
from oracle_content.integrity import admit as admission
from oracle_content.integrity import manifest as manifests
from oracle_content.integrity import zimmap
from oracle_content.integrity.medium import DEFAULT_READ_RATE
from oracle_content.integrity.mend import mend_all
from oracle_content.integrity.scrub import scrub
from oracle_content.integrity.state import PENDING_RELOAD, State
from oracle_content.models import ContentError, Document, ReadRequest, SearchRequest
from oracle_content.precompute import build_spans
from oracle_content.service import Service
from oracle_content.store import Store
from tests.test_content import profile
from tests_integration.test_native import NativeDense, build
from tests_integration.test_zim import Article

LEAF = 8192
WORDS = [f"w{number}" for number in range(4000)]


def write_archive(path, name, articles):
    chooser = random.Random(name)
    with Creator(str(path)).config_indexing(True, "eng").config_clustersize(24 * 1024) as creator:
        for index in range(articles):
            filler = " ".join(chooser.choice(WORDS) for _ in range(160))
            body = (f"<p>Article {index} of {name} describes topic{index}x and a paraphrase of it.</p>"
                    f"<h2>Detail</h2><p>{filler}</p>")
            creator.add_item(Article(f"A{index:03d}", f"{name} {index}", body))
        creator.set_mainpath("A000")


def tokenizer(tmp_path):
    words = Tokenizer(models.WordLevel({"[UNK]": 0}, unk_token="[UNK]"))
    words.pre_tokenizer = pre_tokenizers.Whitespace()
    path = tmp_path / "tokenizer.json"
    words.save(str(path))
    return path, hashlib.sha256(path.read_bytes()).hexdigest()


def library(tmp_path, names=("first",), articles=60, qualified=False):
    token_path, token_sha = tokenizer(tmp_path)
    settings = dict(encoder_tokenizer=str(token_path), encoder_tokenizer_sha256=token_sha, encoder_max_tokens=400,
                    response_tokens=100000, read_tokens=100000, embedding_batch=8, page_size=50, lexical_depth=20,
                    chat_tokenizer=str(token_path), chat_tokenizer_sha256=token_sha, vector_datatype="float16")
    if qualified:
        settings.update(qualified=True, receipts=["fixture-admission.json"])
    settings = profile(**settings)
    store, dense = Store(tmp_path / "state"), NativeDense()
    manifest_dir = tmp_path / "manifest"
    manifest_dir.mkdir()
    (manifest_dir / "corpus.json").write_bytes(manifests.render(manifests.empty(LEAF)))
    archives = {}
    for name in names:
        path = tmp_path / f"{name}.zim"
        write_archive(path, name, articles)
        sha = hashlib.sha256(path.read_bytes()).hexdigest()
        doc = Document(document_id="archive", work_id=name, pack_id=name, title=name.title(), language="en",
                       source_url="https://example.org/" + name, sha256=sha, media_type="application/x-zim",
                       license="CC0", extraction_revision="html-structural-v4", original_path=str(path))
        generation = build(store, doc, settings, dense, token_path)
        admission.admit(store.root, sha, kind="upstream", pack_path=f"sources/{name}.zim", sources=[],
                        leaf_bytes=LEAF, parity_dir=tmp_path / "parity", parity_group=4)
        admission.publish_candidate(store.root, sha, manifest_dir)
        archives[name] = SimpleNamespace(sha=sha, generation=generation, path=store.root / "originals" / sha)
    scrub(store.root, manifest_dir)
    service = Service(store, settings, dense, TokenCounter(str(token_path), settings.encoder_tokenizer_sha256),
                      ZimLexical())
    return SimpleNamespace(store=store, service=service, manifest=manifest_dir, archives=archives, profile=settings)


def structure(item, archive):
    state = State(item.store.root / "integrity")
    row = state.artifact(archive.sha)
    state.close()
    return zimmap.StructureMap(item.store.root / "integrity" / "structure" / (archive.sha + ".map"), row["map_sha256"])


def entry_index(archive, path):
    from libzim.reader import Archive
    return Archive(str(archive.path)).get_entry_by_path(path)._index


def damage(path, offset, length=24):
    stat = path.stat()
    with open(path, "r+b") as stream:
        stream.seek(offset)
        original = stream.read(length)
        stream.seek(offset)
        stream.write(bytes(byte ^ 0x5A for byte in original))
    os.utime(path, ns=(stat.st_atime_ns, stat.st_mtime_ns))


def cluster_middle(item, archive, entry):
    mapped = structure(item, archive)
    start, end = mapped.entry_extent(entry)
    mapped.close()
    return (start + end) // 2


def status(item, archive, leaf):
    state = State(item.store.root / "integrity")
    try:
        return state.leaf(archive.sha, leaf)["status"]
    finally:
        state.close()


def test_i13_localisation_uses_the_structure_taken_at_admission(tmp_path):
    item = library(tmp_path)
    archive = item.archives["first"]
    target = entry_index(archive, "A030")
    offset = cluster_middle(item, archive, target)
    mapped = structure(item, archive)
    tables = next((start, end) for start, end, kind in mapped.regions if kind == "cluster_pointers")
    mapped.close()
    # The live cluster-pointer table is garbled before any localisation runs.
    damage(archive.path, tables[0], min(64, tables[1] - tables[0]))
    damage(archive.path, offset)
    scrub(item.store.root, item.manifest)
    state = State(item.store.root / "integrity")
    table_leaf, document_leaf = tables[0] // LEAF, offset // LEAF
    assert state.leaf(archive.sha, table_leaf)["status"] == "damaged"
    table = state.localization(archive.sha, table_leaf)
    assert table["class"] == "structural" and "cluster_pointers" in table["structural_regions"]
    located = state.localization(archive.sha, document_leaf)
    state.close()
    assert target in located["entries"] and located["documents"] >= 1
    if document_leaf != table_leaf:
        assert located["class"] in ("document", "index")


@pytest.mark.parametrize("names", [("first",), ("first", "second")])
def test_i9_quarantined_bytes_never_reach_a_response(tmp_path, names):
    item = library(tmp_path, names=names)
    archive = item.archives["first"]
    target = entry_index(archive, "A030")
    document_id = f"z_{archive.sha}_{target}"
    # Read and search first, so every cache the reader keeps holds this article.
    read = asyncio.run(item.service.read(ReadRequest(document_id=document_id)))
    handle = read["passages"][0]["passage_id"]
    found = asyncio.run(item.service.search(SearchRequest(query="topic30x")))
    assert any(hit["document_id"] == document_id for hit in found["hits"])
    cited = asyncio.run(item.service.read(ReadRequest(document_id=document_id, passage_id=handle)))
    assert cited["passages"]

    leaf = cluster_middle(item, archive, target) // LEAF
    state = State(item.store.root / "integrity")
    state.set_leaf(archive.sha, leaf, "damaged")
    state.close()

    with pytest.raises(ContentError) as refused:
        asyncio.run(item.service.read(ReadRequest(document_id=document_id)))
    assert refused.value.code == "source_damaged" and refused.value.status == 503
    with pytest.raises(ContentError) as refused:
        asyncio.run(item.service.read(ReadRequest(document_id=document_id, passage_id=handle)))
    assert refused.value.code == "source_damaged"
    with pytest.raises(ContentError) as refused:
        item.store.passage(archive.generation, handle)
    assert refused.value.code == "source_damaged"

    found = asyncio.run(item.service.search(SearchRequest(query="topic30x")))
    assert all(hit["document_id"] != document_id for hit in found["hits"])
    assert "integrity:first" in found["degradation"] and found["status"] == "degraded"
    # Dense hits resolve through the same gate: every article carries "paraphrase".
    broad = asyncio.run(item.service.search(SearchRequest(query="paraphrase")))
    assert broad["hits"] and all(hit["document_id"] != document_id for hit in broad["hits"])

    async def source():
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=create_app(item.service)),
                                     base_url="http://test") as client:
            return await client.get("/v1/corpus/source/" + handle)
    response = asyncio.run(source())
    assert response.status_code == 503 and response.json()["error"]["code"] == "source_damaged"

    # A document whose cluster lies wholly outside the quarantined leaf still serves.
    mapped = structure(item, archive)
    healthy = next(index for index in range(60)
                   if mapped.entry_extent(index) and leaf not in mapped.entry_leaves(index, LEAF))
    mapped.close()
    assert asyncio.run(item.service.read(ReadRequest(document_id=f"z_{archive.sha}_{healthy}")))["passages"]


def test_continuations_obey_quarantine_and_cannot_outlive_a_mend(tmp_path, monkeypatch):
    item = library(tmp_path)
    item.service.profile = item.profile.model_copy(update={"page_size": 1})
    archive = item.archives["first"]
    target = entry_index(archive, "A030")
    document_id = f"z_{archive.sha}_{target}"
    overview = asyncio.run(item.service.read(ReadRequest(document_id=document_id)))
    requests = [(item.service.search, SearchRequest(query="paraphrase")),
                (item.service.read, ReadRequest(document_id=document_id,
                                                passage_id=overview["passages"][0]["passage_id"]))]
    continuations = []
    for run, request in requests:
        result = asyncio.run(run(request))
        assert result["cursor"]
        continuations.append((run, request.model_copy(update={"cursor": result["cursor"]})))

    for run, request in continuations:
        assert asyncio.run(run(request))["cursor"]

    stat = archive.path.stat()
    os.utime(archive.path, ns=(stat.st_atime_ns, stat.st_mtime_ns + 1))
    for run, request in continuations:
        with pytest.raises(ContentError) as refused:
            asyncio.run(run(request))
        assert refused.value.code == "unavailable_version"
    os.utime(archive.path, ns=(stat.st_atime_ns, stat.st_mtime_ns))

    leaf = cluster_middle(item, archive, target) // LEAF
    state = State(item.store.root / "integrity")
    state.set_leaf(archive.sha, leaf, "damaged")
    outcomes = []
    for run, request in continuations:
        try:
            asyncio.run(run(request))
        except ContentError as error:
            outcomes.append(error.code)
        else:
            outcomes.append("served_quarantined_snapshot")

    epoch = state.bump_epoch(archive.sha)
    state.set_leaf(archive.sha, leaf, PENDING_RELOAD, verified=True, epoch=epoch)
    state.close()
    # The fresh reader acknowledges the repair. Durable cached text still belongs
    # to the older reader epoch, even when current quarantine is empty.
    assert asyncio.run(item.service.read(ReadRequest(document_id=document_id)))["passages"]
    for run, request in continuations:
        try:
            asyncio.run(run(request))
        except ContentError as error:
            outcomes.append(error.code)
        else:
            outcomes.append("served_pre_mend_snapshot")
    assert outcomes == ["source_damaged", "source_damaged", "invalid_cursor", "invalid_cursor"]

    request = requests[1][1]
    cited = asyncio.run(item.service.read(request))
    reader = item.store.native(archive.generation)
    document = reader.document

    def mend_during_validation(document_id):
        result = document(document_id)
        state = State(item.store.root / "integrity")
        state.bump_epoch(archive.sha)
        state.close()
        return result

    with monkeypatch.context() as gate:
        gate.setattr(reader, "document", mend_during_validation)
        with pytest.raises(ContentError) as refused:
            asyncio.run(item.service.read(request.model_copy(update={"cursor": cited["cursor"]})))
        assert refused.value.code == "invalid_cursor"

    save = item.service.save_snapshot

    def mend_during_retrieval(*args, **kwargs):
        state = State(item.store.root / "integrity")
        state.bump_epoch(archive.sha)
        state.close()
        return save(*args, **kwargs)

    monkeypatch.setattr(item.service, "save_snapshot", mend_during_retrieval)
    for run, request in requests:
        with pytest.raises(ContentError) as refused:
            asyncio.run(run(request))
        assert refused.value.code == "invalid_cursor"


def test_i10_a_reader_opened_before_a_mend_refuses_until_reopened(tmp_path):
    item = library(tmp_path)
    archive = item.archives["first"]
    target = entry_index(archive, "A012")
    document_id = f"z_{archive.sha}_{target}"
    assert asyncio.run(item.service.read(ReadRequest(document_id=document_id)))["passages"]
    before = item.store._native_readers[archive.generation]
    leaf = cluster_middle(item, archive, target) // LEAF

    # What step 8 of a mend records: the leaf verified again at a new epoch.
    state = State(item.store.root / "integrity")
    epoch = state.bump_epoch(archive.sha)
    state.set_leaf(archive.sha, leaf, PENDING_RELOAD, verified=True, epoch=epoch)
    state.close()

    with pytest.raises(ContentError) as refused:
        before.passages(document_id)
    assert refused.value.code == "source_damaged"
    assert asyncio.run(item.service.read(ReadRequest(document_id=document_id)))["passages"]
    after = item.store._native_readers[archive.generation]
    assert after is not before and after.integrity_epoch == epoch
    assert status(item, archive, leaf) == "ok"
    with pytest.raises(ContentError):
        before.passages(document_id)


def test_i18_one_damaged_archive_leaves_the_library_ready(tmp_path):
    item = library(tmp_path, names=("first", "second"), qualified=True)
    first, second = item.archives["first"], item.archives["second"]
    assert item.service.health()["ready"] and item.service.health()["qualified"]
    damage(first.path, 0, 16)  # the ZIM header
    scrub(item.store.root, item.manifest)
    health = item.service.health()
    assert health["ready"] is True and health["qualified"] is True
    assert "integrity:first:withdrawn" in health["degradation"]
    found = asyncio.run(item.service.search(SearchRequest(query="topic7x")))
    assert found["hits"] and {hit["source"]["sha256"] for hit in found["hits"]} == {second.sha}
    assert "integrity:first:withdrawn" in found["degradation"]
    with pytest.raises(ContentError) as refused:
        asyncio.run(item.service.read(ReadRequest(document_id=f"z_{first.sha}_1")))
    assert refused.value.code == "source_damaged"
    coverage = {row["pack_id"]: row["integrity"] for row in health["coverage"]["native_archives"]}
    assert coverage["first"]["withdrawn"] is True and coverage["second"]["withdrawn"] is False


def test_i18_an_archive_that_fails_to_verify_costs_only_itself(tmp_path):
    """The pre-existing coupling: any one archive's receipt failure made the whole library unready."""
    item = library(tmp_path, names=("first", "second"), qualified=True)
    first = item.archives["first"]
    os.utime(first.path, ns=(first.path.stat().st_atime_ns, first.path.stat().st_mtime_ns + 1))
    health = item.service.health()
    assert health["ready"] is True and "archive_unavailable:first" in health["degradation"]
    found = asyncio.run(item.service.search(SearchRequest(query="paraphrase")))
    assert found["hits"] and "archive_unavailable:first" in found["degradation"]


@pytest.mark.parametrize("reader_open", [True, False])
def test_i18_a_missing_original_costs_only_itself(tmp_path, reader_open):
    """An original gone from disk before any scrub notices is archive loss, whether or not its reader is open."""
    item = library(tmp_path, names=("first", "second"), qualified=True)
    first, second = item.archives["first"], item.archives["second"]
    kept = f"z_{second.sha}_{entry_index(second, 'A010')}"
    asyncio.run(item.service.search(SearchRequest(query="paraphrase")))
    if not reader_open:
        item.store._native_readers.clear()
    first.path.unlink()
    health = item.service.health()
    assert health["ready"] is True and "archive_unavailable:first" in health["degradation"]
    found = asyncio.run(item.service.search(SearchRequest(query="paraphrase")))
    assert found["hits"] and {hit["source"]["sha256"] for hit in found["hits"]} == {second.sha}
    assert "archive_unavailable:first" in found["degradation"]
    scoped = asyncio.run(item.service.search(SearchRequest(query="paraphrase", document_id=kept)))
    assert scoped["hits"] and {hit["document_id"] for hit in scoped["hits"]} == {kept}
    assert asyncio.run(item.service.read(ReadRequest(document_id=kept)))["passages"]
    with pytest.raises(ContentError) as refused:
        asyncio.run(item.service.read(ReadRequest(document_id=f"z_{first.sha}_1")))
    assert refused.value.code == "unavailable_version"


def unreadable_state(item):
    """Replace the integrity state with bytes that are not a database, as a new file."""
    path = item.store.root / "integrity" / "state.sqlite"
    spoiled = path.with_name("spoiled")
    spoiled.write_bytes(b"\0" * 8192)
    os.replace(spoiled, path)


def test_i18_unreadable_integrity_state_costs_nothing_and_says_so(tmp_path):
    item = library(tmp_path, names=("first",), qualified=True)
    archive = item.archives["first"]
    document_id = f"z_{archive.sha}_{entry_index(archive, 'A012')}"
    unreadable_state(item)
    health = item.service.health()
    assert health["ready"] is True and health["qualified"] is True
    block = health["coverage"]["native_archives"][0]["integrity"]
    assert block["state_error"] and block["read_verification"] == "state_unreadable"
    assert asyncio.run(item.service.search(SearchRequest(query="paraphrase")))["hits"]
    read = asyncio.run(item.service.read(ReadRequest(document_id=document_id)))
    assert read["passages"] and "integrity:first:read_unverified" in read["degradation"]


def test_known_damage_stays_refused_while_the_state_is_unreadable(tmp_path):
    item = library(tmp_path)
    archive = item.archives["first"]
    target = entry_index(archive, "A030")
    state = State(item.store.root / "integrity")
    state.set_leaf(archive.sha, cluster_middle(item, archive, target) // LEAF, "damaged")
    state.close()
    with pytest.raises(ContentError):
        asyncio.run(item.service.read(ReadRequest(document_id=f"z_{archive.sha}_{target}")))
    unreadable_state(item)
    with pytest.raises(ContentError) as refused:
        asyncio.run(item.service.read(ReadRequest(document_id=f"z_{archive.sha}_{target}")))
    assert refused.value.code == "source_damaged"
    assert item.service.health()["coverage"]["native_archives"][0]["integrity"]["state_error"]


def test_a_read_rehashes_the_bytes_it_returns(tmp_path):
    item = library(tmp_path)
    archive = item.archives["first"]
    target = entry_index(archive, "A044")
    offset = cluster_middle(item, archive, target)
    damage(archive.path, offset)
    with pytest.raises(ContentError) as refused:
        asyncio.run(item.service.read(ReadRequest(document_id=f"z_{archive.sha}_{target}")))
    assert refused.value.code == "source_damaged"
    assert status(item, archive, offset // LEAF) == "suspect"
    scrub(item.store.root, item.manifest)
    assert status(item, archive, offset // LEAF) == "damaged"


def test_a_withdrawal_retires_a_reader_already_open(tmp_path):
    """A withdrawal advances no epoch, so a cached reader must not outlive it."""
    item = library(tmp_path)
    archive = item.archives["first"]
    assert item.store.native(archive.generation) is not None
    state = State(item.store.root / "integrity")
    state.set_artifact_status(archive.sha, "size_mismatch", {"expected": 1, "actual": 2})
    state.close()
    with pytest.raises(ContentError) as refused:
        item.store.native(archive.generation)
    assert refused.value.code == "source_damaged"


def test_a_read_the_rehash_could_not_check_says_so(tmp_path):
    """The leaf lists live in a directory synced separately; moved, reads go unchecked and must be labelled."""
    item = library(tmp_path)
    item.service.profile = item.profile.model_copy(update={"page_size": 1})
    document_id = f"z_{item.archives['first'].sha}_{entry_index(item.archives['first'], 'A012')}"

    def integrity():
        return {row["pack_id"]: row["integrity"] for row in item.service.health()["coverage"]["native_archives"]}

    read = asyncio.run(item.service.read(ReadRequest(document_id=document_id)))
    request = ReadRequest(document_id=document_id, passage_id=read["passages"][0]["passage_id"])
    cited = asyncio.run(item.service.read(request))
    assert cited["cursor"]
    assert not [code for code in read["degradation"] if code.startswith("integrity:")]
    assert integrity()["first"]["read_verification"] == "active"
    item.manifest.rename(item.manifest.with_name("manifest-moved"))
    read = asyncio.run(item.service.read(ReadRequest(document_id=document_id)))
    assert "integrity:first:read_unverified" in read["degradation"] and read["status"] == "degraded"
    assert integrity()["first"]["read_verification"] == "leaf_list_unavailable"
    resumed = asyncio.run(item.service.read(request.model_copy(update={"cursor": cited["cursor"]})))
    assert "integrity:first:read_unverified" in resumed["degradation"] and resumed["status"] == "degraded"


def test_damaged_spans_fall_back_to_the_archive_and_are_moved_aside(tmp_path):
    item = library(tmp_path)
    item.service.profile = item.profile.model_copy(update={"page_size": 1})
    archive = item.archives["first"]
    result = build_spans(item.store, archive.generation, log=lambda line: None)
    assert result["integrity"]["recorded"] is True and result["integrity"]["read_rate"] == DEFAULT_READ_RATE
    document_id = f"z_{archive.sha}_{entry_index(archive, 'A021')}"
    reader = item.store.native(archive.generation)
    assert reader.usable_spans() is not None
    handles = [row.passage_id for row in reader.passages(document_id)]
    request = ReadRequest(document_id=document_id, passage_id=handles[0])
    cited = asyncio.run(item.service.read(request))
    assert cited["cursor"]
    spans = item.store.directory(archive.generation) / "article-spans.sqlite"
    damage(spans, spans.stat().st_size - 2 * LEAF + 100)
    scrub(item.store.root, item.manifest)
    with pytest.raises(ContentError) as refused:
        asyncio.run(item.service.read(request.model_copy(update={"cursor": cited["cursor"]})))
    assert refused.value.code == "invalid_cursor"
    fresh = item.store.native(archive.generation)
    assert fresh.usable_spans() is None
    fresh.cache.clear()
    assert [row.passage_id for row in fresh.passages(document_id)] == handles
    mend_all(item.store.root, item.manifest, network=False)
    assert not spans.exists() and list(spans.parent.glob("article-spans.damaged-*.sqlite"))
    assert item.store.native(archive.generation).spans is None
    assert json.loads(Path(item.store.directory(archive.generation) / "article-spans.status.json").read_text())["published"]
