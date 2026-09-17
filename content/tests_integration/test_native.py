"""Native compact generations with actual local ZIMs and deterministic vectors."""
import asyncio
import hashlib
import json
import shutil

import pytest
from libzim.writer import Creator, Hint
from tokenizers import Tokenizer, models, pre_tokenizers

from oracle_content.adapters import ZimLexical
from oracle_content.extract import TokenCounter
from oracle_content.models import Document, SearchRequest, ReadRequest, ContentError
from oracle_content.native import build_native, point_checksum, selection, article_lead
from oracle_content.service import Service
from oracle_content.store import Store
from tests.test_content import profile, Dense
from tests_integration.test_zim import Article


class NativeDense(Dense):
    async def validate_native(self, generation, count, checksum):
        rows = self.points[generation]
        assert len(rows) == count
        assert sum(point_checksum(p.passage_id, p.document_id) for p in rows.values()) % (1 << 256) == int(checksum, 16)


def fixture(tmp_path, name="first", water_body=None):
    path = tmp_path / (name + ".zim")
    with Creator(str(path)).config_indexing(True, "eng") as archive:
        archive.add_item(Article("Valve", "Valve", "<h2>Overview</h2><p>Equipment with a rotating seal.</p><h2>Repair</h2><p>ZX42 pressure regulator repair.</p>"))
        archive.add_item(Article("Water", "Water", water_body or "<p>A paraphrase about rain barrels.</p><h2>Capacity</h2><p>Tank capacity is 200 liters.</p>"))
        archive.add_redirection("Stopcock", "Stopcock", "Valve", {Hint.FRONT_ARTICLE: True})
        archive.set_mainpath("Valve")
    tokenizer = Tokenizer(models.WordLevel({"[UNK]": 0}, unk_token="[UNK]"))
    tokenizer.pre_tokenizer = pre_tokenizers.Whitespace()
    token_path = tmp_path / "tokenizer.json"
    tokenizer.save(str(token_path))
    token_sha = hashlib.sha256(token_path.read_bytes()).hexdigest()
    p = profile(encoder_tokenizer=str(token_path), encoder_tokenizer_sha256=token_sha,
        encoder_max_tokens=50, response_tokens=10000, read_tokens=10000, embedding_batch=1, page_size=20,
        chat_tokenizer=str(token_path), chat_tokenizer_sha256=token_sha, vector_datatype="float16")
    doc = Document(document_id="archive", work_id=name, pack_id=name, title="Archive", language="en",
        source_url="https://example.org/wiki", sha256=hashlib.sha256(path.read_bytes()).hexdigest(),
        media_type="application/x-zim", license="CC0", extraction_revision="html-structural-v3", original_path=str(path))
    return doc, p, token_path


def build(store, doc, p, dense, token_path):
    return asyncio.run(build_native(store, doc, p, dense, token_path, selection_policy="canonical-html",
        inspection=json.dumps({"checked": True, "source_sha256": doc.sha256, "extraction_revision": doc.extraction_revision,
                               "selection_policy": "canonical-html", "receipt": "local fixture headings and original paragraphs inspected"}), reserve_bytes=1024 * 1024))


def test_native_full_reader_and_independent_search_without_duplicate_catalog(tmp_path):
    doc, p, token_path = fixture(tmp_path)
    store, dense = Store(tmp_path / "state"), NativeDense()
    generation = build(store, doc, p, dense, token_path)
    assert not (store.directory(generation) / "catalog.sqlite").exists()
    assert not (store.root / "extraction-cache.sqlite").exists()
    assert (store.root / "originals" / doc.sha256).stat().st_ino == (tmp_path / "first.zim").stat().st_ino
    assert store.manifest(generation)["indexed_articles"] == 2
    assert store.manifest(generation)["excluded_entries"] == 1
    service = Service(store, p, dense, TokenCounter(str(token_path), p.encoder_tokenizer_sha256), ZimLexical())
    pool = asyncio.run(service.candidates("ZX42"))
    assert pool["branches"]["lexical"]
    # Fake dense intentionally returns Water by paraphrase; lexical finds Valve independently.
    assert pool["branches"]["dense"]
    result = asyncio.run(service.search(SearchRequest(query="ZX42")))
    hit = next(hit for hit in result["hits"] if "ZX42" in hit["excerpt"])
    read = asyncio.run(service.read(ReadRequest(document_id=hit["document_id"], passage_id=hit["passage_id"])))
    assert any("ZX42" in row["excerpt"] for row in read["passages"])
    assert result["coverage"]["native_archives"][0]["dense_stage"] == "complete"
    assert "title/lead" in result["coverage"]["native_archives"][0]["dense_representation"]
    bad = hit["passage_id"][:-1] + ("0" if hit["passage_id"][-1] != "0" else "1")
    with pytest.raises(ContentError):
        store.passage(generation, bad)
    moved = tmp_path / "moved"
    shutil.copytree(store.root, moved)
    assert Store(moved).passage(generation, hit["passage_id"]).text == hit["excerpt"]


def test_interruption_keeps_native_readable_and_resume_acknowledges_once(tmp_path):
    doc, p, token_path = fixture(tmp_path)
    store, dense = Store(tmp_path / "state"), NativeDense()
    dense.fail = True
    with pytest.raises(RuntimeError):
        build(store, doc, p, dense, token_path)
    generation = store.active()
    assert store.manifest(generation)["indexed_articles"] == 0
    service = Service(store, p, dense, TokenCounter(str(token_path), p.encoder_tokenizer_sha256), ZimLexical())
    assert service.health()["ready"]
    assert not service.health()["qualified"]
    result = asyncio.run(service.search(SearchRequest(query="ZX42")))
    assert result["hits"] and "dense_index_incomplete" in result["degradation"]
    dense.fail = False
    assert build(store, doc, p, dense, token_path) == generation
    assert store.manifest(generation)["indexed_articles"] == 2
    assert store.manifest(generation)["excluded_entries"] == 1
    assert len(dense.points[generation]) == 2


def test_library_union_retains_both_archives_and_document_scope(tmp_path):
    first, p, token_path = fixture(tmp_path, "first")
    second, _, _ = fixture(tmp_path, "second")
    store, dense = Store(tmp_path / "state"), NativeDense()
    one = build(store, first, p, dense, token_path)
    two = build(store, second, p, dense, token_path)
    assert set(store.active_generations()) == {one, two}
    service = Service(store, p, dense, TokenCounter(str(token_path), p.encoder_tokenizer_sha256), ZimLexical())
    result = asyncio.run(service.search(SearchRequest(query="ZX42")))
    assert set(result["coverage"]["active_packs"]) == {"first", "second"}
    assert {hit["source_revision"] for hit in result["hits"]} == {first.sha256, second.sha256}
    hit = next(row for row in result["hits"] if row["source_revision"] == first.sha256)
    scoped = asyncio.run(service.search(SearchRequest(query="ZX42", document_id=hit["document_id"])))
    assert all(row["document_id"] == hit["document_id"] for row in scoped["hits"])


def test_source_selection_requires_explicit_license_and_preserves_permission_exceptions():
    declaration = '<span data-template="Page data" data-param="license" data-value="CC-BY-SA-3.0"></span><span data-template="Page data" data-param="language" data-value="en"></span>'
    assert selection(declaration + "<p>Compost instructions.</p>", "appropedia-explicit-open-english-v1") == (True, None, "CC-BY-SA-3.0")
    assert not selection(declaration + "<p>All rights reserved</p>", "appropedia-explicit-open-english-v1")[0]
    assert not selection("<p>Undeclared source</p>", "appropedia-explicit-open-english-v1")[0]
    assert not selection('<div class="mw-parser-output" lang="ja">' + declaration + '</div>', "appropedia-explicit-open-english-v1")[0]


def test_title_lead_scope_ignores_navigation_infoboxes_and_later_sections():
    source = '<p>Navigation</p><div class="mw-parser-output"><table><tr><td><p>Infobox</p></td></tr></table><p>Opening <b>article</b> prose.</p><h2>Later topic</h2><p>Later fact</p></div>'
    assert article_lead(source, 200) == "Opening article prose."
    assert article_lead(source, 7) == "Opening"
    assert article_lead('<div class="mw-parser-output"><h2>Section</h2><p>Later</p>', 200) == ""


def test_archive_activation_retains_existing_practical_catalog(tmp_path):
    from oracle_content.ingest import build as build_catalog_generation
    from tests.test_content import document, validation, Tokens
    native_doc, p, token_path = fixture(tmp_path)
    store, dense = Store(tmp_path / "state"), NativeDense()
    manual = document(tmp_path, "retained-manual")
    old = asyncio.run(build_catalog_generation(store, [manual], p, dense, Tokens(), validation(manual)))
    new = build(store, native_doc, p, dense, token_path)
    assert set(store.active_generations()) == {old, new}
    service = Service(store, p, dense, TokenCounter(str(token_path), p.encoder_tokenizer_sha256), ZimLexical())
    result = asyncio.run(service.search(SearchRequest(query="paraphrase")))
    assert {hit["source_revision"] for hit in result["hits"]} == {manual.sha256, native_doc.sha256}
    assert set(result["coverage"]["active_packs"]) == {"fixture", "first"}


def test_new_math_extraction_does_not_retarget_historical_native_handles(tmp_path):
    from tests.test_inline_math import SOURCE, EXPECTED
    doc, p, token_path = fixture(tmp_path, water_body=SOURCE)
    store, dense = Store(tmp_path / "state"), NativeDense()
    old = build(store, doc, p, dense, token_path)
    old_reader = store.native(old)
    index = old_reader.archive.get_entry_by_path("Water")._index
    old_lead = old_reader.representative(index)
    assert '12 m 2 ' in old_lead.text
    new = build(store, doc.model_copy(update={"extraction_revision": "html-structural-v4"}), p, dense, token_path)
    new_lead = store.native(new).representative(index)
    assert new != old and new_lead.passage_id != old_lead.passage_id
    assert store.passage(old, old_lead.passage_id).text == old_lead.text
    assert store.passage(new, new_lead.passage_id).text == EXPECTED
    assert ''.join(row.text for row in store.native(new).passages(new_lead.document_id)) == EXPECTED
    assert store.active_generations() == [new]
    assert (store.root / 'originals' / doc.sha256).is_file()


def test_default_license_and_rights_discussion_do_not_exclude_open_articles():
    html = '<div class="mw-parser-output" lang="en"><p>This page discusses copyrighted material.</p></div>'
    assert selection(html, 'appropedia-open-english-v2') == (True, None, 'CC-BY-SA-4.0')
    public_domain = html + '<span data-template="Page data" data-param="license" data-value="Public domain"></span>'
    assert selection(public_domain, 'appropedia-open-english-v2') == (True, None, 'Public domain')
    private = html + '<span data-template="Page data" data-param="license" data-value="proprietary"></span>'
    assert selection(private, 'appropedia-open-english-v2') == (False, 'explicit_other_license', None)
