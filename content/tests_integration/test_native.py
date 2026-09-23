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


WIKISOURCE_ENTRIES = {
    "The Laws of Manu": "<p>The great sages approached Manu, seated with collected mind.</p>",
    "Hymns of the Rigveda/Mandala 1": "<p>Agni I laud, the herald of the sacrifice.</p>",
    "Page:Laws of Manu.djvu/12": "<p>12 THE LAWS OF MANU. The great sa- ges approached</p>",
    "A/Page:Laws of Manu.djvu/13": "<p>13 THE LAWS OF MANU. Manu, seated with col- lected</p>",
    "Page%3ARigveda.djvu/4": "<p>4 HYMNS OF THE RIGVEDA. Agni I laud, the her- ald</p>",
    "Index:Laws of Manu.djvu": "<p>Index of the scanned volume.</p>",
}
MAINSPACE_ENTRIES = 2


def wikisource_fixture(tmp_path, name="wikisource"):
    """An archive shaped like a proofreading wiki: assembled works beside their scans.

    The scan pages carry the same words as the works they were transcribed into, so an
    archive indexed without a namespace policy answers a search twice from one work.
    """
    path = tmp_path / (name + ".zim")
    with Creator(str(path)).config_indexing(True, "eng") as archive:
        for entry, body in WIKISOURCE_ENTRIES.items():
            archive.add_item(Article(entry, entry, body))
        archive.set_mainpath("The Laws of Manu")
    _doc, p, token_path = fixture(tmp_path, name + "-profile")
    doc = Document(document_id="archive", work_id=name, pack_id=name, title="Wikisource", language="en",
        source_url="https://en.wikisource.org/wiki", sha256=hashlib.sha256(path.read_bytes()).hexdigest(),
        media_type="application/x-zim", license="public-domain-or-CC-BY-SA-4.0",
        extraction_revision="html-structural-v4", original_path=str(path))
    return doc, p, token_path


def build(store, doc, p, dense, token_path, policy="canonical-html", **reservations):
    reservations.setdefault("content_state_reserve_bytes", 1024 * 1024)
    return asyncio.run(build_native(store, doc, p, dense, token_path, selection_policy=policy,
        inspection=json.dumps({"checked": True, "source_sha256": doc.sha256, "extraction_revision": doc.extraction_revision,
                               "selection_policy": policy, "receipt": "local fixture headings and original paragraphs inspected"}), **reservations))


def test_each_reservation_measures_only_the_filesystem_it_names(tmp_path):
    """The content-state floor and the index-storage ceiling are separate quantities.

    The first build leaves the vector store already allocated well past the content-state
    number and runs to completion against its own, larger ceiling; the second keeps that
    ceiling below the same allocation and is stopped. One shared number cannot produce
    both outcomes, so this is what tells the two checks apart.
    """
    doc, p, token_path = fixture(tmp_path)
    index = tmp_path / "index"
    index.mkdir()
    (index / "segment").write_bytes(b"x" * (4 * 1024 * 1024))
    dense = NativeDense()
    generation = build(Store(tmp_path / "state"), doc, p, dense, token_path, index_storage=index,
        content_state_reserve_bytes=1024 * 1024, index_storage_reserve_bytes=64 * 1024 * 1024)
    manifest = Store(tmp_path / "state").manifest(generation)
    assert manifest["dense_stage"] == "complete"
    assert manifest["observed_index_allocated_bytes"] >= 4 * 1024 * 1024
    assert manifest["content_state_reserve_bytes"] == 1024 * 1024
    assert manifest["index_storage_reserve_bytes"] == 64 * 1024 * 1024
    with pytest.raises(ValueError, match="index-storage reservation"):
        build(Store(tmp_path / "capped"), doc, p, dense, token_path, index_storage=index,
            content_state_reserve_bytes=1024 * 1024, index_storage_reserve_bytes=1024 * 1024)


def test_a_declared_index_directory_without_its_own_reservation_is_refused(tmp_path):
    doc, p, token_path = fixture(tmp_path)
    index = tmp_path / "index"
    index.mkdir()
    with pytest.raises(ValueError, match="index-storage allocation reservation"):
        build(Store(tmp_path / "state"), doc, p, NativeDense(), token_path, index_storage=index)


def test_an_archive_still_indexing_never_joins_a_serving_library(tmp_path):
    """The union is qualified only while every member's index is complete, and a gateway
    refuses chat while it is not, so an archive added beside a served library joins only
    once indexed. One built without joining joins, marked active, on its next run."""
    doc, p, token_path = fixture(tmp_path)
    p = p.model_validate({**p.model_dump(), "qualified": True, "receipts": ["fixture-admission.json"]})
    store, dense = Store(tmp_path / "state"), NativeDense()
    serving = build(store, doc, p, dense, token_path)
    service = Service(store, p, dense, TokenCounter(str(token_path), p.encoder_tokenizer_sha256), ZimLexical())
    added, _, _ = fixture(tmp_path, "second", water_body="<p>Cistern overflow valves.</p>")
    dense.fail = True
    with pytest.raises(RuntimeError):
        build(store, added, p, dense, token_path)
    assert store.active_generations() == [serving]
    assert service.health()["qualified"]
    dense.fail = False
    held = build(store, added, p, dense, token_path, activate=False)
    assert store.active_generations() == [serving]
    assert build(store, added, p, dense, token_path) == held
    assert set(store.active_generations()) == {serving, held}
    assert service.health()["qualified"]


def test_a_scanned_books_source_is_its_scan_while_the_scan_is_installed(tmp_path):
    """A text archive read from scanned books sends a reader to the scan itself. The text
    stands in while the scans are not installed, and a scan whose integrity receipt no
    longer matches its bytes is never served."""
    import os
    import httpx
    from libzim.writer import Item, StringProvider
    from oracle_content.app import create_app
    from oracle_content.ingest import publish_original

    class Scan(Item):
        def __init__(self, path, payload):
            super().__init__()
            self.path, self.payload = path, payload
        def get_path(self):
            return self.path
        def get_title(self):
            return self.path
        def get_mimetype(self):
            return "application/pdf"
        def get_contentprovider(self):
            return StringProvider(self.payload)
        def get_hints(self):
            return {Hint.FRONT_ARTICLE: False}

    book = "www.example.org/library/field_manual_1902.pdf"
    scan = "%PDF-1.4 scanned field manual " * 50000
    crawl = tmp_path / "crawl.zim"
    with Creator(str(crawl)) as archive:
        archive.add_item(Scan(book, scan))
    crawl_sha = hashlib.sha256(crawl.read_bytes()).hexdigest()
    doc, p, token_path = fixture(tmp_path)
    text = tmp_path / "text.zim"
    with Creator(str(text)).config_indexing(True, "eng") as archive:
        archive.add_metadata("Scans", crawl_sha)
        archive.add_item(Article(book, "Field Manual (1902)", "<p>Trench revetment with brushwood fascines.</p>"))
    doc = doc.model_copy(update={"sha256": hashlib.sha256(text.read_bytes()).hexdigest(), "original_path": str(text),
                                 "extraction_revision": "html-structural-v4"})
    store, dense = Store(tmp_path / "state"), NativeDense()
    build(store, doc, p, dense, token_path)
    service = Service(store, p, dense, TokenCounter(str(token_path), p.encoder_tokenizer_sha256), ZimLexical())
    handle = asyncio.run(service.search(SearchRequest(query="revetment")))["hits"][0]["passage_id"]

    async def source():
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=create_app(service)), base_url="http://test") as client:
            return await client.get("/v1/corpus/source/" + handle)

    before = asyncio.run(source())
    assert before.headers["content-type"].startswith("text/plain") and "revetment" in before.text
    installed = publish_original(store, crawl, crawl_sha, False)
    served = asyncio.run(source())
    assert served.status_code == 200 and served.headers["content-type"] == "application/pdf"
    assert served.content == scan.encode()
    assert served.headers["content-disposition"].startswith("inline; ")
    stat = installed.stat()
    os.utime(installed, ns=(stat.st_atime_ns, stat.st_mtime_ns + 1))
    assert asyncio.run(source()).headers["content-type"].startswith("text/plain")


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
    multiword = asyncio.run(service.candidates("ZX42 pressure"))
    assert multiword["branches"]["lexical"]
    assert any("ZX42 pressure" in multiword["passages"][pid].text for pid, _ in multiword["branches"]["lexical"])
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


def test_native_article_is_displayed_under_its_own_title_and_names_its_archive(tmp_path):
    import httpx
    from oracle_content.app import create_app
    doc, p, token_path = fixture(tmp_path)
    store, dense = Store(tmp_path / "state"), NativeDense()
    generation = build(store, doc, p, dense, token_path)
    service = Service(store, p, dense, TokenCounter(str(token_path), p.encoder_tokenizer_sha256), ZimLexical())
    hit = next(h for h in asyncio.run(service.search(SearchRequest(query="ZX42")))["hits"] if h["title"] == "Valve")
    assert hit["collection"] == "Archive"
    async def check():
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=create_app(service)), base_url="http://test") as client:
            response = await client.get("/v1/corpus/source/" + hit["passage_id"])
            assert response.status_code == 200 and "rotating seal" in response.text
            header = response.headers["content-disposition"]
            assert hit["passage_id"] not in header
            assert header.startswith('inline; filename="Valve.txt"')
    asyncio.run(check())


def test_mainspace_policy_refuses_proofreading_namespaces_by_path_alone():
    """Admission follows the entry path, in every spelling a ZIM writes it."""
    def decoded():
        raise AssertionError("a path-decided policy must not decode the article")
    assert selection(decoded, "wikisource-mainspace-v1", "The Laws of Manu") == (True, None, None)
    assert selection(decoded, "wikisource-mainspace-v1", "Hymns of the Rigveda/Mandala 1")[0]
    for scan in ("Page:Laws of Manu.djvu/12", "A/Page:Laws of Manu.djvu/13",
                 "Page%3ARigveda.djvu/4", "Index:Laws of Manu.djvu", "A/Index:Rigveda.djvu"):
        assert selection(decoded, "wikisource-mainspace-v1", scan) == (False, "proofreading_scan_page", None)
    with pytest.raises(ValueError):
        selection(decoded, "wikisource-mainspace-v1")


def test_repair_policy_admits_repair_content_and_not_member_profiles():
    """Most of iFixit's archive is member profile pages, which hold a name and no repair
    content; the policy decides from the path without decoding the page."""
    def decoded():
        raise AssertionError("a path-decided policy must not decode the article")
    for repair in ("Guide/iPad+Mini+2+Headphone+Jack+Replacement/36038", "Device/Acer_Aspire_A515-47",
                   "Teardown/Nintendo+Switch+Teardown/78263", "A/Guide/Fan+Replacement/1"):
        assert selection(decoded, "ifixit-repair-v1", repair) == (True, None, None)
    for other in ("User/4583204/Wilbert", "home", "about-us", "Guidelines"):
        assert selection(decoded, "ifixit-repair-v1", other) == (False, "not_repair_content", None)
    with pytest.raises(ValueError):
        selection(decoded, "ifixit-repair-v1")


def test_book_policy_admits_each_books_text_and_not_the_scrapers_catalog_pages():
    """A Gutenberg archive's cover and author pages hold a title and no text; indexed, each
    book answers a search twice and every author once more with nothing to read."""
    book = '<html><head><meta name="dc.title" content="Heartbreak House"/></head><body><p>Act I.</p></body></html>'
    catalog = "<html><body><header>Project Gutenberg Library The first producer of free ebooks</header></body></html>"
    def never():
        raise AssertionError("a cover is refused by its path without decoding")
    assert selection(lambda: book, "gutenberg-books-v1", "Heartbreak House.3543") == (True, None, None)
    assert selection(never, "gutenberg-books-v1", "Heartbreak House_cover.3543") == (False, "book_cover_page", None)
    assert selection(lambda: catalog, "gutenberg-books-v1", "S. D. (Susan Dunning) Power.34868") == (False, "catalog_page", None)


def test_mainspace_generation_indexes_assembled_works_and_not_their_scans(tmp_path):
    """One work is indexed once: the assembled text, never the scanned pages beside it.

    The count the pack's footprint declares is the archive's own HTML-entry count less
    the entries this policy refuses, so it is asserted against what the build indexed.
    """
    doc, p, token_path = wikisource_fixture(tmp_path)
    store, dense = Store(tmp_path / "state"), NativeDense()
    generation = build(store, doc, p, dense, token_path, policy="wikisource-mainspace-v1")
    manifest = store.manifest(generation)
    scans = len(WIKISOURCE_ENTRIES) - MAINSPACE_ENTRIES
    assert manifest["indexed_articles"] == MAINSPACE_ENTRIES
    assert manifest["excluded_entries"] == scans
    assert manifest["exclusion_reasons"] == {"proofreading_scan_page": scans}
    assert manifest["canonical_html_articles"] - scans == manifest["indexed_articles"]
    assert len(dense.points[generation]) == MAINSPACE_ENTRIES
    reader = store.native(generation)
    work = reader.document_id(reader.archive.get_entry_by_path("The Laws of Manu")._index)
    # Wikisource licensing is per page; the policy resolves none, so the archive's
    # own declaration stands rather than being erased by the admission.
    assert reader.document(work).license == "public-domain-or-CC-BY-SA-4.0"
    scan = reader.document_id(reader.archive.get_entry_by_path("Page:Laws of Manu.djvu/12")._index)
    with pytest.raises(ContentError) as refused:
        reader.document(scan)
    assert refused.value.code == "source_excluded"
    service = Service(store, p, dense, TokenCounter(str(token_path), p.encoder_tokenizer_sha256), ZimLexical())
    hits = asyncio.run(service.search(SearchRequest(query="sages")))["hits"]
    assert hits and all("Page:" not in hit["title"] for hit in hits)
    # The listing counts what a search can reach, not the archive's whole entry table.
    listing = next(row for row in service.collections()["collections"] if row["title"] == "Wikisource")
    assert listing["articles"] == MAINSPACE_ENTRIES and listing["indexing_complete"]
