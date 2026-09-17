"""Real libzim integration; requires the pinned extraction extra, no network."""
import asyncio
import hashlib
from libzim.writer import Creator, Item, StringProvider, Hint
from oracle_content.ingest import zim_documents, build
from oracle_content.adapters import ZimLexical
from oracle_content.models import Document, SearchRequest
from oracle_content.service import Service
from oracle_content.store import Store
from tests.test_content import profile, Dense, Tokens


class Article(Item):
    def __init__(self, path, title, text):
        super().__init__()
        self.path, self.title, self.text = path, title, text
    def get_path(self):
        return self.path
    def get_title(self):
        return self.title
    def get_mimetype(self):
        return "text/html"
    def get_contentprovider(self):
        return StringProvider(self.text)
    def get_hints(self):
        return {Hint.FRONT_ARTICLE: True}


def test_native_zim_search_and_streamed_article_identity(tmp_path):
    path = tmp_path / "fixture.zim"
    with Creator(str(path)).config_indexing(True, "eng") as archive:
        archive.add_item(Article("Valve", "Valve", "<h1>Valve</h1>" + "<p>General equipment description.</p>" * 25 + "<p>ZX42 pressure regulator</p>"))
        archive.add_item(Article("Water", "Water", "<h1>Water</h1><p>A paraphrase about rain barrels</p>"))
        archive.add_redirection("Stopcock", "Stopcock", "Valve", {Hint.FRONT_ARTICLE: True})
        archive.set_mainpath("Valve")
    doc = Document(document_id="archive", work_id="fixture", pack_id="fixture", title="Archive",
        language="en", source_url="https://example.org/archive", sha256=hashlib.sha256(path.read_bytes()).hexdigest(),
        media_type="application/x-zim", license="CC0", extraction_revision="html-structural-v4", original_path=str(path))
    documents = list(zim_documents(doc))
    assert {d.article_path for d in documents} == {"Valve", "Water"}
    assert all(d.zim_native_index for d in documents)
    from libzim.reader import Archive
    assert Archive(str(path)).get_entry_by_path("Stopcock").get_item().path == "Valve"
    store, dense, p = Store(tmp_path / "state"), Dense(), profile()
    evidence = {"adapters": {"application/x-zim:html-structural-v4": {"checked": True, "receipt": "native-fixture"}}}
    asyncio.run(build(store, iter(documents), p, dense, Tokens(), evidence, managed_originals=True))
    service = Service(store, p, dense, Tokens(), ZimLexical())
    result = asyncio.run(service.search(SearchRequest(query="ZX42")))
    assert any("ZX42" in h["excerpt"] for h in result["hits"])
    pool = asyncio.run(service.candidates("ZX42 pressure"))
    assert pool["branches"]["lexical"]
    hits = list(result["hits"])
    while result["cursor"]:
        result = asyncio.run(service.search(SearchRequest(query="ZX42", cursor=result["cursor"])))
        hits.extend(result["hits"])
    assert any("ZX42" in h["excerpt"] for h in hits)
    with store.connect(store.active()) as db:
        assert db.execute("SELECT count(*) FROM fts").fetchone()[0] == 0


def test_catalog_native_discovery_uses_exact_title_when_bm25_omits_it(tmp_path, monkeypatch):
    import libzim.search
    path = tmp_path / "titles.zim"
    with Creator(str(path)).config_indexing(True, "eng") as archive:
        archive.add_item(Article("Water", "Water", "<h1>Water</h1><p>Liquid properties.</p>"))
        archive.add_item(Article("Companies", "Companies", "<h1>Companies</h1><p>Water water companies.</p>"))
        archive.set_mainpath("Water")
    doc = Document(document_id="archive", work_id="fixture", pack_id="fixture", title="Archive",
        language="en", source_url="https://example.org/archive", sha256=hashlib.sha256(path.read_bytes()).hexdigest(),
        media_type="application/x-zim", license="CC0", extraction_revision="html-structural-v4", original_path=str(path))
    store, dense, p = Store(tmp_path / "state"), Dense(), profile()
    evidence = {"adapters": {"application/x-zim:html-structural-v4": {"checked": True, "receipt": "fixture"}}}
    asyncio.run(build(store, zim_documents(doc), p, dense, Tokens(), evidence, managed_originals=True))
    class Results:
        def getResults(self, start, limit):
            return ["Companies"]
    class Searcher:
        def __init__(self, archive): pass
        def search(self, query): return Results()
    monkeypatch.setattr(libzim.search, "Searcher", Searcher)
    service = Service(store, p, dense, Tokens(), ZimLexical())
    pool = asyncio.run(service.candidates("water"))
    assert any(pool["passages"][pid].document_id == next(
        d.document_id for d in zim_documents(doc) if d.article_path == "Water"
    ) for pid, _ in pool["branches"]["lexical"])
