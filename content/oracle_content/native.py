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
from urllib.parse import quote

from bs4 import BeautifulSoup

from .extract import TokenCounter, html_blocks, segment, decode_zim_html, inline_content
from .models import ContentError, Document, Passage, Profile, digest
from .store import atomic_json, HANDLE

KIND = "native-zim-article-v1"
POLICIES = {"canonical-html", "appropedia-explicit-open-english-v1", "appropedia-open-english-v2"}


class NativeLexicalHits(list):
    """Carry already-localized evidence across the asynchronous retrieval boundary."""
    def __init__(self, rows, passages):
        super().__init__(rows)
        self.passages = passages


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


def selection(html, policy):
    if policy == "canonical-html":
        return True, None, None
    if policy not in {"appropedia-explicit-open-english-v1", "appropedia-open-english-v2"}:
        raise ValueError("Unknown native source selection policy")
    soup = BeautifulSoup(html, "html.parser")
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
        self.archive = Archive(str(self.path))
        try:
            date = bytes(self.archive.get_metadata("Date")).decode("ascii") if "Date" in self.archive.metadata_keys else ""
            self.archive_edition = "Archive " + date if re.fullmatch(r"\d{4}-\d{2}-\d{2}", date) else ""
        except (KeyError, UnicodeError):
            self.archive_edition = ""
        self.cache = OrderedDict()
        self.document_cache = OrderedDict()
        self.cache_bytes = 0
        self.cache_lock = threading.RLock()

    def verify_original(self):
        stat = self.path.stat()
        receipt = json.loads(self.path.with_suffix(".receipt.json").read_text())
        if receipt.get("sha256") != self.template.sha256 or receipt.get("size") != stat.st_size or receipt.get("mtime_ns") != stat.st_mtime_ns:
            raise ContentError("unavailable_version", "Original archive integrity receipt changed", 410)

    def entry(self, index):
        if index < 0 or index >= self.archive.entry_count:
            raise ContentError("unknown_document", "Native article index is outside this archive", 404)
        entry = self.archive._get_entry_by_id(index)
        if entry.is_redirect or not html_type(entry.get_item().mimetype):
            raise ContentError("unknown_document", "Entry is not a canonical HTML article", 404)
        return entry

    def document(self, document_id):
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
            allowed, _, explicit = selection(decode_zim_html(entry.get_item()), self.policy)
            if not allowed:
                raise ContentError("source_excluded", "Article is outside the declared source selection", 404)
            license = explicit
        return self.template.model_copy(update={"document_id": document_id, "title": entry.title,
            "edition": self.template.edition or self.archive_edition,
            "article_path": entry.path, "zim_native_index": True, "license": license,
            "source_url": self.template.source_url.rstrip("/") + "/" + quote(entry.path, safe="/()_'"),
            "original_path": self.template.original_path})

    def blocks(self, index):
        entry = self.entry(index)
        return html_blocks(decode_zim_html(entry.get_item()), self.template.extraction_revision)

    def passages(self, document_id):
        with self.cache_lock:
            return self._passages(document_id)

    def _passages(self, document_id):
        self.verify_original()
        if document_id in self.cache:
            self.cache.move_to_end(document_id)
            return self.cache[document_id][0]
        document = self.document(document_id)
        index = int(document_id.rsplit("_", 1)[1])
        rows = segment(document, self.blocks(index), self.profile, self.tokenizer, self.generation)
        for row in rows:
            row.passage_id = span_handle(self.generation, index, row)
        for ordinal, row in enumerate(rows):
            row.previous = rows[ordinal - 1].passage_id if ordinal else None
            row.next = rows[ordinal + 1].passage_id if ordinal + 1 < len(rows) else None
        size = sum(len(row.model_dump_json().encode()) for row in rows)
        if size <= 8 * 1024 * 1024:
            while self.cache and (len(self.cache) >= 16 or self.cache_bytes + size > 32 * 1024 * 1024):
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

    def representative(self, index):
        document = self.document(self.document_id(index))
        if self.representation == "title-lead-v1":
            blocks = self.blocks(index)
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
        entry = self.entry(index)
        lead, lead_flags = article_lead(decode_zim_html(entry.get_item()), self.profile.encoder_max_tokens * 16,
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
            paths = await zim.search(str(self.path), safe, limit) if safe else []
            # Full-text BM25 can bury a long article beneath pages repeating its
            # title. The archive's title index supplies an exact navigation hit.
            title = query.strip().replace("_", " ")
            for candidate in dict.fromkeys((title, title[:1].upper() + title[1:])):
                try:
                    entry = self.archive.get_entry_by_title(candidate)
                except KeyError:
                    continue
                paths = [entry.path, *(path for path in paths if path != entry.path)][:limit]
                break
        return await asyncio.to_thread(self._localize, paths, query, limit, document_id)

    def _localize(self, paths, query, limit, document_id):
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
        return NativeLexicalHits(selected, {pid: localized_passages[pid] for pid, _score in selected})


async def build_native(store, template: Document, profile: Profile, dense, tokenizer_path: Path, *,
                       selection_policy: str, inspection: str, reserve_bytes: int, activate=True,
                       index_storage: Path | None = None, workers: int = 1):
    """Prepare source-native access and resume one-vector-per-article indexing."""
    from .ingest import publish_original
    if selection_policy not in POLICIES or not inspection or reserve_bytes < 1 or not 1 <= workers <= 64:
        raise ValueError("Native source policy, inspection and positive disk reservation are required")
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
            if shutil.disk_usage(store.root).free < reserve_bytes:
                raise ValueError("Native corpus indexing reservation does not fit available disk")
            publish_original(store, Path(template.original_path), template.sha256, True)
            canonical = template.model_copy(update={"original_path": "originals/" + template.sha256})
            # Persist the exact tokenizer used to regenerate this generation's spans.
            shutil.copyfile(tokenizer_path, directory / "encoder-tokenizer.json")
            TokenCounter(str(directory / "encoder-tokenizer.json"), profile.encoder_tokenizer_sha256)
            manifest = {**identity, "source": canonical.model_dump(), "generation": generation,
                "stage": "active" if activate else "validated", "dense_stage": "indexing",
                "extraction_profile": profile.model_dump(), "inspection": evidence,
                "packs": [template.pack_id], "document_count": 0, "passage_count": 0,
                "entry_cursor": 0, "indexed_articles": 0, "excluded_entries": 0,
                "exclusion_reasons": {}, "point_checksum": "0", "reserve_bytes": reserve_bytes,
                "failures": [], "dense_representation": "title/lead only; not full article bodies"}
            atomic_json(manifest_path, manifest)
        reader = NativeReader(store, generation)
        reader.verify_original()
        if not reader.archive.has_fulltext_index:
            raise ValueError("Compact native generations require the archive's full-text index")
        manifest["entry_count"] = reader.archive.entry_count
        manifest["archive_article_count_including_redirects"] = reader.archive.article_count
        try:
            counter = bytes(reader.archive.get_metadata("Counter")).decode("utf-8") if "Counter" in reader.archive.metadata_keys else ""
            # MIME parameters contain semicolons; match count boundaries, not a naive split.
            manifest["canonical_html_articles"] = sum(int(number) for mime, number in
                re.findall(r"(?:^|;)(text/html(?:;[^=;]+=[^;]+)*|application/xhtml\+xml)=(\d+)(?=;|$)", counter)) if counter else None
        except (KeyError, UnicodeError):
            manifest["canonical_html_articles"] = None
        atomic_json(manifest_path, manifest)
        if activate:
            store.include_active(generation)
        if manifest["dense_stage"] == "complete":
            return generation
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
                    if shutil.disk_usage(store.root).free < max(256 * 1024 * 1024, reserve_bytes // 20):
                        raise ValueError("Native corpus indexing paused before exhausting its filesystem")
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
                        if allocated >= reserve_bytes:
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
                    allowed, reason, _ = selection(decode_zim_html(entry.get_item()), selection_policy)
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
        return generation
