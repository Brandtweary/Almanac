"""Compact ZIM generations: native originals, article vectors, regenerated spans."""
from __future__ import annotations
from collections import OrderedDict
from concurrent.futures import ProcessPoolExecutor
import fcntl
import hashlib
import json
from pathlib import Path
import re
import shutil
import sqlite3
import struct
import multiprocessing
import asyncio
import threading
import time
import traceback
from html.parser import HTMLParser
from html import escape
from urllib.parse import quote, unquote, urlsplit

from bs4 import BeautifulSoup

from .extract import TokenCounter, html_blocks, segment, decode_zim_html, inline_content
from .models import ContentError, Document, Passage, Profile, digest
from .precompute import ArticleSpans, binding as spans_binding, rebuild as rebuild_passages
from .store import atomic_json, HANDLE

# An archive's own `M/Counter` names each mimetype it holds and how many entries carry
# it. MIME parameters contain semicolons, so the count boundaries are matched rather
# than split on. One definition serves both the ingest, which counts what it is about
# to index, and the remote inspector, which counts it before the archive is acquired:
# two spellings of this would let a declared footprint disagree with the index built
# from it without either side noticing.
INDEXED_MIME_COUNTS = re.compile(r"(?:^|;)(text/html(?:;[^=;]+=[^;]+)*|application/xhtml\+xml)=(\d+)(?=;|$)")


def counted_html_entries(counter: str | None):
    """How many entries a compact native generation indexes, or None without a counter."""
    if not counter:
        return None
    return sum(int(number) for _mimetype, number in INDEXED_MIME_COUNTS.findall(counter))


KIND = "native-zim-article-v1"
POLICIES = {"canonical-html", "appropedia-explicit-open-english-v1", "appropedia-open-english-v2",
            "wikisource-mainspace-v1", "ifixit-repair-v1", "gutenberg-books-v1"}

# iFixit's repair content: step-by-step guides, the device pages that collect them and
# their troubleshooting, teardowns, and the site's own reference articles. The archive's
# remaining pages are member profiles and site navigation.
IFIXIT_REPAIR_SECTIONS = ("Guide", "Device", "Teardown", "Info")

# A Gutenberg archive holds each book's own HTML beside pages its scraper generates: a
# cover page per book, carrying the title, author and license and nothing of the text,
# and a page per author, whose listing only a browser script fills. Covers are named by
# path; every scraper page carries the site header below, and no book's own HTML does.
GUTENBERG_COVER = re.compile(r"_cover\.\d+$")
GUTENBERG_SCRAPER_PAGE = "The first producer of free ebooks"

# MediaWiki proofreading namespaces, carrying one entry per scanned page and per
# scanned volume. A selection policy naming them admits the assembled works alone.
SCAN_WORKFLOW_NAMESPACES = ("Page:", "Index:")

# One lexical search localizes up to `lexical_depth` articles from this archive,
# and each localization decodes, block-parses and segments a whole article —
# hundreds of milliseconds for an ordinary page and seconds for a long one. A
# cache smaller than that working set is evicted by the very search that filled
# it, so the repeat of a broad query costs what the first one did; the residency
# here covers a search's articles and leaves room for the next query to overlap
# it. The per-entry ceiling keeps one enormous article from owning the cache.
PASSAGE_CACHE_DOCUMENTS = 96
PASSAGE_CACHE_BYTES = 256 * 1024 * 1024
PASSAGE_CACHE_ENTRY_BYTES = 8 * 1024 * 1024


class NativeLexicalHits(list):
    """Carry already-localized evidence across the asynchronous retrieval boundary.

    `damaged` counts archive hits dropped because their bytes are quarantined, so the
    response can say that results are missing rather than presenting fewer as all.
    """
    def __init__(self, rows, passages, damaged=0):
        super().__init__(rows)
        self.passages = passages
        self.damaged = damaged


def article_lead(html, max_characters, revision="html-structural-v4", *, with_flags=False):
    """Read opening article prose without parsing the complete article DOM."""
    if revision not in {"html-structural-v3", "html-structural-v4"}:
        raise ValueError("Unsupported native lead extraction revision")
    legacy = revision == "html-structural-v3"
    root = re.search(r'<(?:div|section)\b[^>]*class=["\'][^"\']*\bmw-parser-output\b[^"\']*["\'][^>]*>', html, re.I)
    if root is None:
        root = re.search(r"<body\b[^>]*>", html, re.I)
    class Finished(Exception):
        pass
    class Lead(HTMLParser):
        def __init__(self):
            super().__init__(convert_charrefs=True)
            self.paragraphs, self.current, self.skipped = [], None, []
            self.fragment, self.fragment_tag, self.fragment_depth, self.flags = None, None, 0, set()
        def handle_starttag(self, tag, attrs):
            if self.fragment is not None:
                self.fragment.append(self.get_starttag_text())
                if tag == self.fragment_tag:
                    self.fragment_depth += 1
                return
            if tag in {"table", "figure", "script", "style", "nav", "noscript"}:
                self.skipped.append(tag)
            if self.skipped:
                return
            if tag in {"h2", "h3", "h4", "h5", "h6"}:
                raise Finished()
            if tag == "p":
                self.current = []
            if not legacy and self.current is not None:
                if tag in {"sup", "sub", "math"}:
                    self.fragment, self.fragment_tag, self.fragment_depth = [self.get_starttag_text()], tag, 1
                elif tag == "img" and "math" in dict(attrs).get("class", ""):
                    text, flags = inline_content(BeautifulSoup(self.get_starttag_text(), "html.parser").find("img"))
                    self.current.append(text)
                    self.flags.update(flags)
        def handle_endtag(self, tag):
            if self.fragment is not None:
                self.fragment.append(f"</{tag}>")
                if tag == self.fragment_tag:
                    self.fragment_depth -= 1
                    if self.fragment_depth == 0:
                        text, flags = inline_content(BeautifulSoup("".join(self.fragment), "html.parser").find(self.fragment_tag))
                        self.current.append(text)
                        self.flags.update(flags)
                        self.fragment = None
                return
            if self.skipped:
                if tag == self.skipped[-1]:
                    self.skipped.pop()
                return
            if tag == "p" and self.current is not None:
                text = " ".join((" ".join(self.current) if legacy else "".join(self.current)).split())
                if text:
                    self.paragraphs.append(text)
                self.current = None
                if len("\n\n".join(self.paragraphs)) >= max_characters:
                    raise Finished()
        def handle_data(self, data):
            if self.fragment is not None:
                self.fragment.append(escape(data))
                return
            if self.current is not None and not self.skipped:
                self.current.append(data)
                if sum(map(len, self.current)) >= max_characters:
                    self.handle_endtag("p")
    parser = Lead()
    start = root.end() if root else 0
    try:
        for offset in range(start, len(html), 4096):
            parser.feed(html[offset:offset + 4096])
        parser.close()
    except Finished:
        pass
    if parser.current:
        parser.paragraphs.append(" ".join((" ".join(parser.current) if legacy else "".join(parser.current)).split()))
    text = "\n\n".join(parser.paragraphs)[:max_characters]
    return (text, sorted(parser.flags)) if with_flags else text


def html_type(value):
    return value.split(";", 1)[0].strip().lower() in {"text/html", "application/xhtml+xml"}


def scan_workflow_page(path):
    """Whether an entry path names a MediaWiki proofreading page rather than a work.

    `Page:` is one entry per scanned page image and `Index:` one per scanned volume;
    both belong to the transcription workflow. A ZIM writes an article either at its
    bare title or under a single-letter namespace directory, and percent-encodes the
    title, so the prefix is tested after undoing both spellings.
    """
    if not isinstance(path, str):
        raise ValueError("A namespace selection policy requires the entry path")
    title = path[2:] if re.match("[A-Z]/", path) else path
    return unquote(title).startswith(SCAN_WORKFLOW_NAMESPACES)


def selection(html, policy, path=None):
    """Admit or refuse one archive entry under a source selection policy.

    `html` may be the entry's decoded HTML or a callable returning it, and a policy
    deciding from the path alone never calls it: decoding an archive's every entry to
    reach a verdict the path already carries costs the whole archive's decompression.
    Returns admission, a refusal reason, and an explicit license when the policy
    resolved one from the article itself — `None` leaves the archive's own in place.
    """
    if policy == "canonical-html":
        return True, None, None
    if policy == "wikisource-mainspace-v1":
        # Each transcribed work is also assembled in the mainspace under its own
        # title, so admitting the proofreading namespaces indexes every work a
        # second time as disconnected OCR pages. Licensing is per page on this
        # source and stays with the archive's declaration rather than being read
        # out of the article body.
        if scan_workflow_page(path):
            return False, "proofreading_scan_page", None
        return True, None, None
    if policy == "ifixit-repair-v1":
        if not isinstance(path, str):
            raise ValueError("A path selection policy requires the entry path")
        section = (path[2:] if re.match("[A-Z]/", path) else path).split("/", 1)[0]
        if section not in IFIXIT_REPAIR_SECTIONS:
            return False, "not_repair_content", None
        return True, None, None
    if policy == "gutenberg-books-v1":
        if not isinstance(path, str):
            raise ValueError("A path selection policy requires the entry path")
        if GUTENBERG_COVER.search(path):
            return False, "book_cover_page", None
        if GUTENBERG_SCRAPER_PAGE in (html() if callable(html) else html):
            return False, "catalog_page", None
        return True, None, None
    if policy not in {"appropedia-explicit-open-english-v1", "appropedia-open-english-v2"}:
        raise ValueError("Unknown native source selection policy")
    soup = BeautifulSoup(html() if callable(html) else html, "html.parser")
    fields = {node.get("data-param"): node.get("data-value") for node in soup.select('[data-template="Page data"][data-param]')}
    body = soup.select_one(".mw-parser-output") or soup
    language = body.get("lang") or fields.get("language")
    if language != "en":
        return False, "language_not_explicit_english", None
    if policy == "appropedia-open-english-v2":
        # Empty Page-data attributes select the site's documented CC-BY-SA-4.0
        # default; they are not a contrary declaration. Source-bound exceptions
        # are explicit manifest entries, never broad word matches in article prose.
        license = fields.get("license") or "CC-BY-SA-4.0"
        allowed = {"CC-BY-SA-2.0", "CC-BY-SA-2.5", "CC-BY-SA-3.0", "CC-BY-SA-4.0",
                   "CC-BY-2.0", "CC-BY-2.5", "CC-BY-3.0", "CC-BY-4.0", "CC0", "CC0-1.0", "Public domain"}
        return (True, None, license) if license in allowed else (False, "explicit_other_license", None)
    if fields.get("license") not in {"CC-BY-SA-3.0", "CC-BY-SA-4.0", "CC-BY-3.0", "CC-BY-4.0", "CC0"}:
        return False, "license_not_explicit_open", None
    # Specific permission warnings override a generic page-data license declaration.
    prose = body.get_text(" ", strip=True).lower()
    if any(warning in prose for warning in ("permission to share", "all rights reserved", "used by permission", "used with permission", "copyrighted material")):
        return False, "page_permission_exception", None
    return True, None, fields["license"]


def span_handle(generation, entry_index, passage):
    coords = struct.pack(">IIII", entry_index, passage.block_index, passage.start, passage.end)
    check = hashlib.sha256(coords + passage.text.encode("utf-8")).digest()[:16]
    return f"p:{generation}:{(coords + check).hex()}"


def point_checksum(passage_id, document_id):
    return int(digest([passage_id, document_id]), 16)


_worker_reader = None


def _representative_worker(root, generation, index):
    global _worker_reader
    from .store import Store
    if _worker_reader is None or _worker_reader.generation != generation or str(_worker_reader.store.root) != root:
        _worker_reader = NativeReader(Store(Path(root)), generation)
    try:
        return _worker_reader.representative(index)
    except Exception as error:
        raise ValueError(f"Native article entry {index} could not be represented: {error}") from error


class NativeReader:
    def __init__(self, store, generation):
        from libzim.reader import Archive
        self.store, self.generation = store, generation
        manifest = store.manifest(generation)
        self.template = Document.model_validate(manifest["source"])
        self.representation = manifest.get("representation")
        if self.representation not in {"title-lead-v1", "title-lead-v2"} or self.template.extraction_revision not in {"html-structural-v3", "html-structural-v4"}:
            raise ContentError("unsupported_extraction_revision", "Native extraction implementation is unavailable; retained original bytes remain installed", 409)
        self.policy = manifest["selection_policy"]
        self.rights_exclusions = manifest.get("rights_exclusions", {})
        self.profile = Profile.model_validate(manifest["extraction_profile"])
        self.tokenizer = TokenCounter(str(store.directory(generation) / "encoder-tokenizer.json"), self.profile.encoder_tokenizer_sha256)
        self.path = store.root / self.template.original_path
        # The epochs are read before the archive is opened: a mend that lands in between
        # then leaves this reader marked older than the mend, so it refuses what the mend
        # touched until it is reopened, rather than trusting a cache it cannot vouch for.
        self.integrity = store.integrity
        self.artifact = self.template.sha256
        self.integrity_epoch = self.integrity.epoch(self.artifact)
        self.spans_epoch = self.integrity.epoch("spans-" + generation)
        try:
            self.archive = Archive(str(self.path))
        except RuntimeError:
            # libzim reports a missing or unparseable file this way; either is the loss of
            # this one archive, which the library serves around.
            raise ContentError("unavailable_version", "Original archive cannot be opened", 410) from None
        try:
            date = bytes(self.archive.get_metadata("Date")).decode("ascii") if "Date" in self.archive.metadata_keys else ""
            self.archive_edition = "Archive " + date if re.fullmatch(r"\d{4}-\d{2}-\d{2}", date) else ""
        except (KeyError, UnicodeError):
            self.archive_edition = ""
        self.cache = OrderedDict()
        self.document_cache = OrderedDict()
        self.cache_bytes = 0
        self.cache_lock = threading.RLock()
        # Article spans computed once at ingest time. Absent, partial or bound to
        # another generation, every path below falls back to computing them.
        self.spans = ArticleSpans.open(store.directory(generation), spans_binding(self))

    def verify_original(self):
        """Refuse an original that is gone, unreadable or changed since its receipt, as the loss of this archive."""
        try:
            stat = self.path.stat()
            receipt = json.loads(self.path.with_suffix(".receipt.json").read_text())
        except (OSError, ValueError):
            raise ContentError("unavailable_version", "Original archive is unavailable", 410) from None
        if receipt.get("sha256") != self.template.sha256 or receipt.get("size") != stat.st_size or receipt.get("mtime_ns") != stat.st_mtime_ns:
            raise ContentError("unavailable_version", "Original archive integrity receipt changed", 410)

    def stale(self):
        """Whether a mend, or a withdrawal of the spans, since this reader opened requires reopening it.

        The archive's own withdrawal advances no epoch; the store checks it on every call.
        """
        return (self.integrity.epoch(self.artifact) != self.integrity_epoch
                or self.integrity.epoch("spans-" + self.generation) != self.spans_epoch)

    def admit_entry(self, index):
        """Refuse an entry whose bytes lie in quarantine, before anything decodes them.

        This is the one gate every path to an article's text passes: reads, search
        localization, dense-hit resolution and cited handles, whether the text would
        come from the archive or from its precomputed spans.
        """
        view = self.integrity.archive(self.artifact)
        if view is None:
            return
        reason = view.blocked(index, self.integrity_epoch)
        if reason is not None:
            from .integrity.overlay import message
            raise ContentError("source_damaged", message(reason, self.template.title))

    def verify_read(self, index):
        """Re-hash an article's leaves before its text is returned to a person reading it.

        Returns the overlay's outcome, so a read the re-hash could not check is labelled
        as such rather than passing for a verified one.
        """
        from .integrity.overlay import REFUSED
        try:
            outcome = self.integrity.verify_entry(self.artifact, self.path, index)
        except OSError:
            raise ContentError("unavailable_version", "Original archive is unavailable", 410) from None
        if outcome == REFUSED:
            from .integrity.overlay import message
            raise ContentError("source_damaged", message("damaged", self.template.title))
        return outcome

    def usable_spans(self):
        """The precomputed spans, unless integrity has withdrawn them; the query path then answers."""
        if self.spans is None or not self.integrity.spans_usable(self.generation, self.spans_epoch):
            return None
        return self.spans

    def entry(self, index):
        if index < 0 or index >= self.archive.entry_count:
            raise ContentError("unknown_document", "Native article index is outside this archive", 404)
        entry = self.archive._get_entry_by_id(index)
        if entry.is_redirect or not html_type(entry.get_item().mimetype):
            raise ContentError("unknown_document", "Entry is not a canonical HTML article", 404)
        return entry

    def document(self, document_id):
        match = re.fullmatch(r"z_([a-f0-9]{64})_([0-9]+)", document_id)
        if match and match[1] == self.template.sha256:
            self.admit_entry(int(match[2]))
        with self.cache_lock:
            if document_id in self.document_cache:
                self.document_cache.move_to_end(document_id)
                return self.document_cache[document_id]
            document = self._document(document_id)
            self.document_cache[document_id] = document
            if len(self.document_cache) > 256:
                self.document_cache.popitem(last=False)
            return document

    def _document(self, document_id):
        match = re.fullmatch(r"z_([a-f0-9]{64})_([0-9]+)", document_id)
        if not match or match[1] != self.template.sha256:
            raise ContentError("unknown_document", "Invalid native article identity", 404)
        index = int(match[2])
        entry = self.entry(index)
        if entry.path in self.rights_exclusions:
            raise ContentError("source_excluded", "Article has an unresolved contrary source-rights notice", 404)
        license = self.template.license
        if self.policy != "canonical-html":
            # A selection policy reads the article's own page-data, which means
            # parsing its whole DOM. An article present in the precomputed spans
            # was admitted by this same policy under this same binding when they
            # were built, and carries the license that admission resolved.
            spans = self.usable_spans()
            stored = spans.raw(index) if spans is not None else None
            if stored is not None and stored[3] is not None:
                license = stored[3]
            else:
                allowed, _, explicit = selection(lambda: decode_zim_html(entry.get_item()), self.policy, entry.path)
                if not allowed:
                    raise ContentError("source_excluded", "Article is outside the declared source selection", 404)
                # A policy that resolves no license of its own leaves the archive's
                # declaration standing; overwriting it with None would erase it.
                if explicit is not None:
                    license = explicit
        base = self.template.source_url.rstrip("/")
        host = urlsplit(base).netloc
        source_url = (urlsplit(base).scheme + "://" + quote(entry.path, safe="/()_'")) if host and entry.path.startswith(host + "/") else base + "/" + quote(entry.path, safe="/()_'")
        return self.template.model_copy(update={"document_id": document_id, "title": entry.title,
            "edition": self.template.edition or self.archive_edition,
            "article_path": entry.path, "zim_native_index": True, "license": license,
            "source_url": source_url,
            "original_path": self.template.original_path})

    def blocks(self, index):
        self.admit_entry(index)
        entry = self.entry(index)
        return html_blocks(decode_zim_html(entry.get_item()), self.template.extraction_revision)

    def passages(self, document_id):
        with self.cache_lock:
            return self._passages(document_id)

    def segment_article(self, document, index, blocks=None):
        """Segment one article and give its passages their span-addressed handles."""
        rows = segment(document, self.blocks(index) if blocks is None else blocks,
                       self.profile, self.tokenizer, self.generation)
        for row in rows:
            row.passage_id = span_handle(self.generation, index, row)
        for ordinal, row in enumerate(rows):
            row.previous = rows[ordinal - 1].passage_id if ordinal else None
            row.next = rows[ordinal + 1].passage_id if ordinal + 1 < len(rows) else None
        return rows

    def _passages(self, document_id):
        self.verify_original()
        match = re.fullmatch(r"z_([a-f0-9]{64})_([0-9]+)", document_id)
        if match and match[1] == self.template.sha256:
            self.admit_entry(int(match[2]))
        if document_id in self.cache:
            self.cache.move_to_end(document_id)
            return self.cache[document_id][0]
        document = self.document(document_id)
        index = int(document_id.rsplit("_", 1)[1])
        spans = self.usable_spans()
        stored = spans.raw(index) if spans is not None else None
        if stored is None:
            rows = self.segment_article(document, index)
        else:
            rows = rebuild_passages(document, self.generation, index, stored[0], stored[1],
                                    self.profile, self.tokenizer)
        size = sum(len(row.model_dump_json().encode()) for row in rows)
        if size <= PASSAGE_CACHE_ENTRY_BYTES:
            while self.cache and (len(self.cache) >= PASSAGE_CACHE_DOCUMENTS
                                  or self.cache_bytes + size > PASSAGE_CACHE_BYTES):
                _, (_, old_size) = self.cache.popitem(last=False)
                self.cache_bytes -= old_size
            self.cache[document_id] = (rows, size)
            self.cache_bytes += size
        return rows

    def passage(self, handle):
        self.verify_original()
        match = HANDLE.fullmatch(handle)
        if not match or match[1] != self.generation:
            raise ContentError("invalid_handle", "Invalid native passage identity", 400)
        index, block, start, end = struct.unpack(">IIII", bytes.fromhex(match[2])[:16])
        if block == 0xFFFFFFFF:
            row = self.representative(index)
            if row.passage_id != handle:
                raise ContentError("unknown_passage", "Native lead identity or content does not match", 404)
            return row
        for row in self.passages(self.document_id(index)):
            if (row.block_index, row.start, row.end) == (block, start, end) and row.passage_id == handle:
                return row
        raise ContentError("unknown_passage", "Native passage identity or content does not match", 404)

    def representative(self, index, *, html=None, blocks=None, stored=True):
        """The article's one indexed vector row, and what a dense-only hit resolves to.

        A search resolves every dense candidate through here, so leaving it out
        of the precompute would keep a whole-article decode and parse on the
        query path for each one. `html` and `blocks` let the builder reuse work
        it has already done; `stored=False` makes it recompute, which is how the
        builder verifies what it is about to store.
        """
        self.admit_entry(index)
        spans = self.usable_spans() if stored else None
        if spans is not None:
            precomputed = spans.raw(index)
            if precomputed is not None:
                return precomputed[2]
        document = self.document(self.document_id(index))
        if self.representation == "title-lead-v1":
            blocks = self.blocks(index) if blocks is None else blocks
            if not blocks:
                raise ValueError("Canonical article has no extracted text")
            lead = []
            for block in blocks:
                if block.kind == "heading" and lead:
                    break
                if block.kind in {"paragraph", "list_item"}:
                    lead.append(block.text)
            text = self.profile.document_prefix + document.title + "\n" + "\n".join(lead)
            width = min(len(text), self.profile.encoder_max_tokens * 4)
            while self.tokenizer.count(text[:width]) > self.profile.encoder_max_tokens:
                if width <= 1:
                    raise ValueError("Article representation cannot fit the encoder")
                width = max(1, width // 2)
            block_index = next((i for i, block in enumerate(blocks) if block.kind == "paragraph" and block.text.strip()), 0)
            row = segment(document, [blocks[block_index]], self.profile, self.tokenizer, self.generation)[0]
            row.block_index = block_index
            row.passage_id = span_handle(self.generation, index, row)
            row.embedding_text = text[:width]
            return row
        if html is None:
            html = decode_zim_html(self.entry(index).get_item())
        lead, lead_flags = article_lead(html, self.profile.encoder_max_tokens * 16,
            self.template.extraction_revision, with_flags=True)
        text = self.profile.document_prefix + document.title + "\n" + lead
        width = min(len(text), self.profile.encoder_max_tokens * 4)
        while self.tokenizer.count(text[:width]) > self.profile.encoder_max_tokens:
            if width <= 1:
                raise ValueError("Article representation cannot fit the encoder")
            width = max(1, width // 2)
        embedding_text = text[:width]
        row = Passage(passage_id="", document_id=document.document_id, source_revision=document.sha256,
            extraction_revision=document.extraction_revision, ordinal=0, block_index=0xFFFFFFFF,
            start=0, end=len(lead), text=lead, embedding_text=embedding_text, section=[], kind="article_lead",
            page={"index": None, "label": None, "coordinates": None, "anchor": None},
            flags=["text_omitted", "title_lead_semantic_representation", *lead_flags, *( ["title_only_no_opening_prose"] if not lead else [])])
        row.passage_id = span_handle(self.generation, index, row)
        row.embedding_text = embedding_text
        return row

    def document_id(self, index):
        return f"z_{self.template.sha256}_{index}"

    async def lexical(self, zim, query, limit, document_id=None):
        self.verify_original()
        paths = []
        if not document_id:
            # libzim combines terms with AND and disables Boolean syntax;
            # injected OR would be another required word, not an operator.
            safe = " ".join(re.findall(r"[^\W_]+", query))
            paths = await zim.search(str(self.path), safe, limit, title_query=query) if safe else []
        return await asyncio.to_thread(self._localize, paths, query, limit, document_id)

    def _localize(self, paths, query, limit, document_id):
        damaged = 0
        if document_id:
            documents = [self.document(document_id)]
        else:
            documents = []
            for path in paths:
                entry = self.archive.get_entry_by_path(path)
                if entry.is_redirect:
                    entry = entry.get_redirect_entry()
                try:
                    documents.append(self.document(self.document_id(entry._index)))
                except ContentError as error:
                    if error.code == "source_damaged":
                        damaged += 1
                        continue
                    if error.code not in {"source_excluded", "unknown_document"}:
                        raise
        ranked = []
        localized_passages = {}
        tokens = re.findall(r"[^\W_]+(?:[-./][^\W_]+)*", query)
        expression = " OR ".join('"' + token + '"' for token in tokens)
        for article_rank, document in enumerate(documents, 1):
            if len(ranked) >= limit:
                # Every remaining article has this score or less even for its
                # first passage. Strict inequality retains deterministic ties.
                upper_bound = 1 / ((self.profile.rrf_k + article_rank) * (self.profile.rrf_k + 1))
                cutoff = sorted((score for _, score in ranked), reverse=True)[limit - 1]
                if upper_bound < cutoff:
                    break
            rows = self.passages(document.document_id)
            db = sqlite3.connect(":memory:")
            try:
                db.execute("CREATE VIRTUAL TABLE article USING fts5(id UNINDEXED,text,tokenize='porter unicode61')")
                db.executemany("INSERT INTO article VALUES(?,?)", [(row.passage_id, row.lexical_text) for row in rows])
                localized = db.execute("SELECT id FROM article WHERE article MATCH ? ORDER BY bm25(article),id LIMIT ?", (expression, limit)).fetchall() if expression else []
            finally:
                db.close()
            candidates = [row[0] for row in localized] or [row.passage_id for row in rows[:limit]]
            wanted = set(candidates)
            localized_passages.update({row.passage_id: row for row in rows if row.passage_id in wanted})
            for rank, pid in enumerate(candidates, 1):
                ranked.append((pid, 1 / ((self.profile.rrf_k + article_rank) * (self.profile.rrf_k + rank))))
        selected = sorted(ranked, key=lambda row: (-row[1], row[0]))[:limit]
        return NativeLexicalHits(selected, {pid: localized_passages[pid] for pid, _score in selected}, damaged)


def serving_generations(store):
    """The generations the library is serving now, or none when nothing is active."""
    try:
        return store.active_generations()
    except ContentError as error:
        if error.code != "corpus_unready":
            raise
        return []


async def build_native(store, template: Document, profile: Profile, dense, tokenizer_path: Path, *,
                       selection_policy: str, inspection: str, content_state_reserve_bytes: int, activate=True,
                       index_storage: Path | None = None, index_storage_reserve_bytes: int = 0,
                       workers: int = 1, category: str = ""):
    """Prepare source-native access and resume one-vector-per-article indexing.

    The two reservations are separate quantities on separate filesystems and neither
    substitutes for the other. `content_state_reserve_bytes` is a free-space floor on the
    content state, which holds the published original and this generation's precomputed
    article spans; the build refuses to start, and pauses in flight, rather than exhaust it.
    `index_storage_reserve_bytes` is an allocation ceiling on `index_storage`, the vector
    store's own directory: the build stops once the segments it has written reach it.

    `category` names the part of the library this archive is listed under. It describes the
    installation rather than the indexed bytes, so it stays out of the generation identity:
    naming or renaming one re-lists an archive without rebuilding it.

    `activate` joins the generation to the active library union. The union is qualified
    only while every member's dense index is complete, so a generation still indexing
    joins at once only when nothing else is being served, where lexical search and
    reading during indexing are worth having; beside a serving library it joins once
    its own index completes. `activate=False` never joins, leaving the caller to finish
    anything else first and join by running the build again.
    """
    from .ingest import publish_original
    if selection_policy not in POLICIES or not inspection or content_state_reserve_bytes < 1 or not 1 <= workers <= 64:
        raise ValueError("Native source policy, inspection and a positive content-state reservation are required")
    if index_storage is not None and index_storage_reserve_bytes < 1:
        raise ValueError("Declared index storage requires a positive index-storage allocation reservation")
    evidence = json.loads(inspection)
    if not isinstance(evidence, dict) or evidence.get("checked") is not True or evidence.get("source_sha256") != template.sha256 or evidence.get("extraction_revision") != template.extraction_revision or evidence.get("selection_policy") != selection_policy:
        raise ValueError("Native extraction inspection does not bind this source and selection")
    exclusions = evidence.get("excluded_articles", {})
    if not isinstance(exclusions, dict) or any(not isinstance(path, str) or not isinstance(reason, str) or not reason for path, reason in exclusions.items()):
        raise ValueError("Source-rights exceptions require explicit article paths and reasons")
    identity = {"kind": KIND, "source": template.model_dump(exclude={"original_path"}),
                "index_fingerprint": profile.index_fingerprint, "selection_policy": selection_policy,
                "representation": "title-lead-v2", "vector_datatype": profile.vector_datatype,
                "rights_exclusions": exclusions}
    generation = digest(identity)
    directory = store.directory(generation)
    directory.mkdir(parents=True, exist_ok=True)
    with (directory / "writer.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        manifest_path = directory / "manifest.json"
        if manifest_path.exists():
            manifest = store.manifest(generation)
        else:
            if shutil.disk_usage(store.root).free < content_state_reserve_bytes:
                raise ValueError("Native corpus content-state reservation does not fit available disk")
            publish_original(store, Path(template.original_path), template.sha256, True)
            canonical = template.model_copy(update={"original_path": "originals/" + template.sha256})
            # Persist the exact tokenizer used to regenerate this generation's spans.
            shutil.copyfile(tokenizer_path, directory / "encoder-tokenizer.json")
            TokenCounter(str(directory / "encoder-tokenizer.json"), profile.encoder_tokenizer_sha256)
            manifest = {**identity, "source": canonical.model_dump(), "generation": generation,
                "stage": "validated", "dense_stage": "indexing",
                "extraction_profile": profile.model_dump(), "inspection": evidence,
                "packs": [template.pack_id], "document_count": 0, "passage_count": 0,
                "entry_cursor": 0, "indexed_articles": 0, "excluded_entries": 0,
                "exclusion_reasons": {}, "point_checksum": "0",
                "content_state_reserve_bytes": content_state_reserve_bytes,
                "index_storage_reserve_bytes": index_storage_reserve_bytes,
                "failures": [], "dense_representation": "title/lead only; not full article bodies"}
            atomic_json(manifest_path, manifest)
        if manifest.get("category", "") != category:
            manifest["category"] = category
            atomic_json(manifest_path, manifest)
        reader = NativeReader(store, generation)
        reader.verify_original()
        if not reader.archive.has_fulltext_index:
            raise ValueError("Compact native generations require the archive's full-text index")
        manifest["entry_count"] = reader.archive.entry_count
        manifest["archive_article_count_including_redirects"] = reader.archive.article_count
        try:
            counter = bytes(reader.archive.get_metadata("Counter")).decode("utf-8") if "Counter" in reader.archive.metadata_keys else ""
            manifest["canonical_html_articles"] = counted_html_entries(counter)
        except (KeyError, UnicodeError):
            manifest["canonical_html_articles"] = None
        atomic_json(manifest_path, manifest)

        def join():
            if manifest["stage"] != "active":
                manifest["stage"] = "active"
                atomic_json(manifest_path, manifest)
            store.include_active(generation)

        if manifest["dense_stage"] == "complete":
            if activate:
                join()
            return generation
        if activate and (not serving_generations(store) or generation in serving_generations(store)):
            join()
        manifest["dense_stage"] = "indexing"
        manifest.pop("failure", None)
        atomic_json(manifest_path, manifest)
        batch = []
        pending_indices = []
        executor = ProcessPoolExecutor(max_workers=workers, mp_context=multiprocessing.get_context("spawn")) if workers > 1 else None
        checkpoint_cursor = manifest["entry_cursor"]
        async def checkpoint(cursor):
            nonlocal batch, checkpoint_cursor, pending_indices
            started = time.perf_counter()
            if pending_indices:
                if executor is None:
                    batch = [reader.representative(index) for index in pending_indices]
                else:
                    loop = asyncio.get_running_loop()
                    batch = await asyncio.gather(*(loop.run_in_executor(executor, _representative_worker,
                        str(store.root), generation, index) for index in pending_indices))
                pending_indices = []
            prepared = time.perf_counter()
            if batch:
                await dense.put(generation, batch)
                metrics = manifest.setdefault("batch_timings", {"batches": 0, "articles": 0, "prepare_seconds": 0, "upsert_seconds": 0})
                metrics["batches"] += 1
                metrics["articles"] += len(batch)
                metrics["prepare_seconds"] += prepared - started
                metrics["upsert_seconds"] += time.perf_counter() - prepared
                metrics["last"] = getattr(dense, "last_timings", {"available": False})
                total = int(manifest["point_checksum"], 16)
                for row in batch:
                    total = (total + point_checksum(row.passage_id, row.document_id)) % (1 << 256)
                manifest["point_checksum"] = format(total, "064x")
                manifest["indexed_articles"] += len(batch)
                batch = []
            manifest["entry_cursor"] = cursor
            manifest["document_count"] = manifest["indexed_articles"]
            # Exact full-body passage count is intentionally not materialized.
            manifest["passage_count"] = None
            atomic_json(manifest_path, manifest)
            checkpoint_cursor = cursor
        try:
            await dense.create(generation)
            for index in range(manifest["entry_cursor"], reader.archive.entry_count):
                if index % 1024 == 0:
                    reader.verify_original()
                    if shutil.disk_usage(store.root).free < max(256 * 1024 * 1024, content_state_reserve_bytes // 20):
                        raise ValueError("Native corpus indexing paused before exhausting the content-state filesystem")
                    if index_storage is not None:
                        if not index_storage.is_dir():
                            raise ValueError("Declared index storage directory is unavailable")
                        allocated = 0
                        for path in index_storage.rglob("*"):
                            try:
                                if path.is_file() and not path.is_symlink():
                                    allocated += path.stat().st_blocks * 512
                            except FileNotFoundError:
                                # Database optimization atomically retires old segment files.
                                continue
                        manifest["observed_index_allocated_bytes"] = allocated
                        if allocated >= index_storage_reserve_bytes:
                            raise ValueError("Native corpus indexing reached its declared index-storage reservation")
                entry = reader.archive._get_entry_by_id(index)
                reason = None
                if entry.is_redirect:
                    reason = "redirect"
                elif not html_type(entry.get_item().mimetype):
                    reason = "non_html"
                elif entry.path in reader.rights_exclusions:
                    reason = "unresolved_contrary_source_notice"
                elif selection_policy != "canonical-html":
                    allowed, reason, _ = selection(lambda: decode_zim_html(entry.get_item()), selection_policy, entry.path)
                    if allowed:
                        reason = None
                if reason:
                    manifest["excluded_entries"] += 1
                    reasons = manifest["exclusion_reasons"]
                    reasons[reason] = reasons.get(reason, 0) + 1
                else:
                    pending_indices.append(index)
                if len(pending_indices) >= profile.embedding_batch or index + 1 - checkpoint_cursor >= 1024:
                    await checkpoint(index + 1)
            await checkpoint(reader.archive.entry_count)
            await dense.validate_native(generation, manifest["indexed_articles"], manifest["point_checksum"])
            manifest["dense_stage"] = "complete"
            manifest.pop("failure", None)
            atomic_json(manifest_path, manifest)
        except BaseException as error:
            # The checkpoint cursor remains at the last acknowledged upsert; in-memory
            # counters after that cursor are discarded before durable failure recording.
            manifest = store.manifest(generation)
            manifest["failure"] = {"entry_index": locals().get("index"), "type": type(error).__name__, "message": str(error), "traceback": traceback.format_exc()}
            manifest["dense_stage"] = "failed"
            atomic_json(manifest_path, manifest)
            raise
        finally:
            if executor is not None:
                executor.shutdown(wait=True, cancel_futures=True)
        if activate:
            join()
        return generation
