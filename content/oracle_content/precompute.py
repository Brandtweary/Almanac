"""Ingest-time article segmentation for compact native generations.

A native generation stores the archive's original bytes and one vector per
article, and nothing else: a search that touches an article decodes it,
block-parses its HTML and segments it before it can rank anything inside it.
That is tens to hundreds of milliseconds of interpreter-bound work per article,
paid again by every visitor who is the first to reach that article.

This module moves the work to a one-time pass over the archive and stores what a
query cannot cheaply recompute — the extracted blocks, the span boundaries
segmentation chose, and the article's semantic representative — beside the
generation. Passage identity is unchanged by construction: the builder runs the
same `segment()` the query path runs, derives the stored form from its output,
reconstructs passages from that stored form and refuses to store an article
whose reconstruction is not identical field for field. An article absent from
the artifact, or an artifact whose binding does not match the generation, simply
leaves the original query-time path in place, so the precompute is an
optimization and never part of the definition of a passage.

The artifact stays outside `manifest.json` and outside the generation identity:
it holds no information that the generation does not already determine, and a
generation without one answers exactly the same, only slower.
"""
from __future__ import annotations

import json
import sqlite3
import threading
import zlib
from pathlib import Path

from .models import Block, Passage

SCHEMA = "native-article-spans-v1"
CODEC = "zlib-6"
FILENAME = "article-spans.sqlite"
BUILDING = "article-spans.building.sqlite"
LOCKNAME = "article-spans.lock"

# Level 6 is the working point: measured over 512 uniformly sampled English
# Wikipedia articles it stores a mean 3190 bytes per article against 3180 for
# level 9, 2999 for xz preset 6 at twelve times the compression cost and five
# times the decompression cost, and 2926 for a 32 KiB pretrained dictionary that
# would have to be stored, bound and versioned with the artifact. None of the
# alternatives is worth its complexity for a seven percent difference.
LEVEL = 6

TABLE_REFERENCE = "[Table requires original source inspection]"


def binding(reader) -> dict:
    """What the stored spans depend on, so a changed generation is never reused.

    The generation identifier already covers source bytes, extraction revision,
    selection policy, rights exclusions and the encoder/segmentation fingerprint,
    because it is their digest. The rest is recorded for a human reading the
    artifact without the manifest beside it.
    """
    return {"schema": SCHEMA, "codec": CODEC, "generation": reader.generation,
            "source_sha256": reader.template.sha256,
            "extraction_revision": reader.template.extraction_revision,
            "representation": reader.representation,
            "selection_policy": reader.policy,
            "index_fingerprint": reader.profile.index_fingerprint}


def encode(blocks: list[Block], passages: list[Passage], lead: Passage, license: str | None) -> bytes:
    """Store only what is not derivable: block text and structure, spans, the representative.

    A passage's own text is `block.text[start:end]`, its embedding text is that
    under the encoder prefix, and its handle is the digest of its coordinates and
    text — so storing the passage rows themselves would store the article's text
    two more times. Passage flags always begin with their block's flags, so only
    the remainder is kept. The representative is stored whole: for the
    `title-lead` representations its text comes from a separate lead reader
    rather than from the blocks, so nothing derives it.
    """
    spans = []
    for passage in passages:
        block = blocks[passage.block_index]
        shared = len(block.flags)
        if passage.flags[:shared] != block.flags:
            raise ValueError("passage flags do not extend their block's flags")
        spans.append([passage.block_index, passage.start, passage.end, passage.flags[shared:]])
    payload = [
        [[b.text, b.kind, b.section, b.page_index, b.page_label, b.coordinates, b.anchor, b.flags] for b in blocks],
        spans, lead.model_dump(), license,
    ]
    return zlib.compress(json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode(), LEVEL)


def decode(blob: bytes):
    raw = json.loads(zlib.decompress(blob))
    blocks = [Block(text=text, kind=kind, section=section, page_index=page_index, page_label=page_label,
                    coordinates=coordinates, anchor=anchor, flags=flags)
              for text, kind, section, page_index, page_label, coordinates, anchor, flags in raw[0]]
    return blocks, raw[1], Passage.model_validate(raw[2]), raw[3]


def rebuild_passage(document, generation, index, ordinal, blocks, span, profile, tokenizer) -> Passage:
    """Reconstruct one passage exactly as `segment()` produced it.

    The encoder prefix is rebuilt the same way, including the abbreviation
    `segment()` applies when section metadata alone fills the encoder window —
    the flag it records is what says the abbreviation happened. A structured
    block too large for the window carries its labelled reference as embedding
    text rather than its own, and that too is recorded in its flags.
    """
    from .native import span_handle
    block_index, start, end, extra = span
    block = blocks[block_index]
    flags = list(block.flags) + list(extra)
    text = block.text[start:end]
    prefix = profile.document_prefix + document.title + "\n" + " / ".join(block.section) + "\n"
    if "embedding_metadata_abbreviated" in flags:
        while prefix and tokenizer.count(prefix) >= max(2, profile.encoder_max_tokens // 2):
            prefix = prefix[:len(prefix) // 2]
    encoded = TABLE_REFERENCE if "table_exceeds_encoder_window" in flags else text
    row = Passage(passage_id="", document_id=document.document_id, source_revision=document.sha256,
                  extraction_revision=document.extraction_revision, ordinal=ordinal,
                  block_index=block_index, start=start, end=end, text=text,
                  embedding_text=prefix + encoded, section=block.section, kind=block.kind,
                  page={"index": block.page_index, "label": block.page_label,
                        "coordinates": block.coordinates, "anchor": block.anchor}, flags=flags)
    row.passage_id = span_handle(generation, index, row)
    return row


def rebuild(document, generation, index, blocks, spans, profile, tokenizer) -> list[Passage]:
    rows = [rebuild_passage(document, generation, index, ordinal, blocks, span, profile, tokenizer)
            for ordinal, span in enumerate(spans)]
    for ordinal, row in enumerate(rows):
        row.previous = rows[ordinal - 1].passage_id if ordinal else None
        row.next = rows[ordinal + 1].passage_id if ordinal + 1 < len(rows) else None
    return rows


class ArticleSpans:
    """Read-only access to one generation's precomputed article spans.

    Connections are per thread because a sqlite3 connection belongs to the thread
    that opened it, and localization runs on whichever worker thread
    `asyncio.to_thread` supplies.
    """

    def __init__(self, path: Path, expected: dict):
        self.path, self.expected = path, expected
        self.local = threading.local()
        self.undecodable = 0
        with self.connect() as db:
            stored = json.loads(db.execute("SELECT value FROM meta WHERE key='binding'").fetchone()[0])
            if stored != expected:
                raise ValueError("precomputed article spans do not bind this generation")
            self.articles = db.execute("SELECT value FROM meta WHERE key='articles'").fetchone()
            self.articles = int(self.articles[0]) if self.articles else None
            row = db.execute("SELECT value FROM meta WHERE key='entry_cursor'").fetchone()
            self.entry_cursor = int(row[0]) if row else None

    @classmethod
    def open(cls, directory: Path, expected: dict):
        """Return the artifact, or None when there is none that binds this generation.

        A mismatched or unreadable artifact is not an error: the query path that
        produced every passage before the artifact existed still produces them.
        """
        path = Path(directory) / FILENAME
        if not path.is_file():
            return None
        try:
            return cls(path, expected)
        except (ValueError, sqlite3.Error, json.JSONDecodeError, TypeError):
            return None

    def connect(self):
        db = getattr(self.local, "db", None)
        if db is None:
            db = self.local.db = sqlite3.connect(self.path.as_uri() + "?mode=ro", uri=True)
        return db

    def raw(self, index: int):
        """One article's stored form, or None when the query path must answer for it.

        A row that no longer decodes is damage to a derived artifact, and derived
        artifacts are never a definition: the article falls back to being segmented from
        the original, exactly as if it had never been precomputed. The fallback is
        counted in `undecodable`, which coverage reports, so a damaged artifact is never
        mistaken for a partial one.
        """
        try:
            row = self.connect().execute("SELECT payload FROM articles WHERE entry_index=?", (index,)).fetchone()
        except sqlite3.Error:
            return None
        if not row:
            return None
        try:
            return decode(row[0])
        except (zlib.error, ValueError, TypeError, KeyError, IndexError):
            # ValueError covers malformed JSON and UTF-8 and a stored row the models reject.
            self.undecodable += 1
            return None


_worker_reader = None


def _reader(root: str, generation: str):
    """One reader per worker process, never consulting the artifact being built."""
    global _worker_reader
    from .native import NativeReader
    from .store import Store
    if (_worker_reader is None or _worker_reader.generation != generation
            or str(_worker_reader.store.root) != root):
        _worker_reader = NativeReader(Store(Path(root)), generation)
    _worker_reader.spans = None
    return _worker_reader


def _chunk(root: str, generation: str, start: int, stop: int):
    """Segment a contiguous range of archive entries and verify each before storing.

    An article is stored only when passages reconstructed from the stored form
    are identical to the ones `segment()` just produced, field for field, so a
    handle cannot change identity by being served from here. Anything that fails
    verification is left out, and the query path answers for it as it always has.
    """
    from .extract import decode_zim_html, html_blocks
    from .models import ContentError
    from .native import html_type
    reader = _reader(root, generation)
    reader.verify_original()
    canonical = reader.policy == "canonical-html"
    rows, skipped, failures = [], 0, []
    for index in range(start, stop):
        try:
            entry = reader.archive._get_entry_by_id(index)
            if entry.is_redirect or not html_type(entry.get_item().mimetype):
                skipped += 1
                continue
            document = reader.document(reader.document_id(index))
        except ContentError:
            skipped += 1
            continue
        try:
            html = decode_zim_html(reader.entry(index).get_item())
            blocks = html_blocks(html, reader.template.extraction_revision)
            passages = reader.segment_article(document, index, blocks)
            lead = reader.representative(index, html=html, blocks=blocks, stored=False)
            blob = encode(blocks, passages, lead, None if canonical else document.license)
            stored_blocks, spans, stored_lead, _license = decode(blob)
            replayed = rebuild(document, generation, index, stored_blocks, spans,
                               reader.profile, reader.tokenizer)
            if [row.model_dump() for row in replayed] != [row.model_dump() for row in passages]:
                raise ValueError("reconstructed passages differ from the segmentation")
            if stored_lead.model_dump() != lead.model_dump():
                raise ValueError("reconstructed representative differs from the article's own")
        except Exception as error:
            failures.append([index, type(error).__name__, str(error)[:400]])
            continue
        rows.append((index, blob))
    return rows, skipped, failures


def status(directory: Path, value: dict):
    from .store import atomic_json
    atomic_json(Path(directory) / "article-spans.status.json", value)


def build_spans(store, generation, *, workers=1, chunk=256, commit=8192,
                min_free_bytes=8 * 1024 ** 3, integrity_rate=None, log=print):
    """Build or resume one generation's article spans, publishing whatever it reaches.

    The artifact is written under a building name and moved into place when the
    run ends, whether it ends by completing, by refusing to crowd the filesystem,
    by an error or by a signal: partial coverage is safe, because an article the
    run never reached is served the way every article is served today. Only an
    untrappable death leaves the artifact unpublished, and that leaves the
    service exactly as it was. A resume moves a published artifact back under the
    building name first, so the live service is never reading a file being
    written; it therefore loses the precompute for the duration of the resume.

    A completed artifact's leaves are then read for integrity at `integrity_rate`
    bytes per second, the integrity default when None.
    """
    import fcntl
    import shutil
    import time
    from concurrent.futures import ProcessPoolExecutor
    import multiprocessing
    from .native import NativeReader

    reader = NativeReader(store, generation)
    reader.spans = None
    reader.verify_original()
    expected = binding(reader)
    directory = store.directory(generation)
    entries = reader.archive.entry_count
    building, final = directory / BUILDING, directory / FILENAME
    state = {"generation": generation, "state": "starting", "entry_count": entries, "published": False}

    with (directory / LOCKNAME).open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        if not building.exists() and final.exists():
            published = ArticleSpans.open(directory, expected)
            if published is None:
                log("discarding an article-spans artifact that does not bind this generation")
                final.unlink()
            elif published.entry_cursor is not None and published.entry_cursor >= entries:
                log(f"article spans are already complete for {generation}")
                return {"state": "complete", "entry_cursor": published.entry_cursor, "published": True}
            else:
                log("resuming: the published artifact is withdrawn until this run ends")
                final.replace(building)
        db = create(building, expected)
        row = db.execute("SELECT value FROM meta WHERE key='entry_cursor'").fetchone()
        cursor = int(row[0]) if row else 0
        # Counters come from the meta row a checkpoint wrote rather than from a
        # scan: counting rows means walking the whole primary key of a table
        # holding millions of articles before the first new one is segmented.
        counted = db.execute("SELECT value FROM meta WHERE key='articles'").fetchone()
        stored = int(counted[0]) if counted else db.execute("SELECT count(*) FROM articles").fetchone()[0]
        skipped = failures = 0
        recorded: list = []
        started, at_start = time.monotonic(), cursor
        executor = (ProcessPoolExecutor(max_workers=workers, mp_context=multiprocessing.get_context("spawn"))
                    if workers > 1 else None)

        def checkpoint(position, terminal=None, error=None):
            nonlocal state
            with db:
                db.execute("INSERT OR REPLACE INTO meta VALUES('entry_cursor',?)", (str(position),))
                db.execute("INSERT OR REPLACE INTO meta VALUES('articles',?)", (str(stored),))
                db.execute("INSERT OR REPLACE INTO meta VALUES('skipped',?)", (str(skipped),))
                db.execute("INSERT OR REPLACE INTO meta VALUES('failures',?)", (str(failures),))
                db.execute("INSERT OR REPLACE INTO meta VALUES('failure_sample',?)",
                           (json.dumps(recorded[:64]),))
            elapsed = max(time.monotonic() - started, 1e-9)
            rate = (position - at_start) / elapsed
            state = {**state, "state": terminal or "running", "entry_cursor": position,
                     "articles": stored, "skipped": skipped, "failures": failures,
                     "failure_sample": recorded[:16], "entries_per_second": round(rate, 1),
                     "remaining_hours": round((entries - position) / rate / 3600, 2) if rate > 0 else None,
                     "artifact_bytes": building.stat().st_size if building.exists() else 0,
                     "free_bytes": shutil.disk_usage(store.root).free}
            if error is not None:
                state["error"] = error
            status(directory, state)
            log(json.dumps({k: v for k, v in state.items() if k != "failure_sample"}))

        terminal, error, position = "complete", None, cursor
        try:
            ranges = [(start, min(start + chunk, entries)) for start in range(cursor, entries, chunk)]
            pending, since = [], 0
            window = max(1, workers * 4)
            index = 0
            while index < len(ranges) or pending:
                while index < len(ranges) and len(pending) < window:
                    start, stop = ranges[index]
                    pending.append((stop, executor.submit(_chunk, str(store.root), generation, start, stop)
                                    if executor is not None else None, (start, stop)))
                    index += 1
                stop, future, bounds = pending.pop(0)
                rows, chunk_skipped, chunk_failures = (future.result() if future is not None
                                                       else _chunk(str(store.root), generation, *bounds))
                with db:
                    db.executemany("INSERT OR REPLACE INTO articles VALUES(?,?)", rows)
                stored += len(rows)
                skipped += chunk_skipped
                failures += len(chunk_failures)
                recorded.extend(chunk_failures)
                del recorded[256:]
                since += stop - position
                position = stop
                if since >= commit:
                    since = 0
                    checkpoint(position)
                    if shutil.disk_usage(store.root).free < min_free_bytes:
                        terminal = "stopped_low_disk"
                        error = "free space reached the configured floor before the archive ended"
                        break
            cursor = position
        except BaseException as exception:
            # A deliberate stop and a fault publish the same partial artifact;
            # only the account it leaves behind differs, and that account is the
            # whole of what a run nobody watched can say for itself.
            terminal = "stopped_by_signal" if isinstance(exception, (KeyboardInterrupt, SystemExit)) else "failed"
            error = f"{type(exception).__name__}: {exception}"
            cursor = position
            raise
        finally:
            if executor is not None:
                executor.shutdown(wait=False, cancel_futures=True)
            checkpoint(cursor, terminal=terminal, error=error)
            db.close()
            if building.exists():
                building.replace(final)
                state["published"] = True
                if terminal == "complete":
                    state["integrity"] = record_spans_leaves(store, generation, integrity_rate)
                status(directory, state)
        return state


def record_spans_leaves(store, generation, rate=None) -> dict:
    """Take a completed artifact's leaf list for scrubbing, the moment it becomes immutable.

    The read is one pass over the whole artifact on the disk the service is reading, so
    it is held to `rate` bytes per second, or the integrity default read rate.
    Failure here never unpublishes the artifact: the spans are an optimization, and the
    account says the leaves were not recorded, so a later scrub reports it unmonitored
    rather than healthy.
    """
    from .integrity.admit import admit_derived
    from .integrity.medium import DEFAULT_READ_RATE, RateLimit
    from .integrity.tree import LEAF_BYTES
    try:
        return {"recorded": True, **admit_derived(store.root, generation, leaf_bytes=LEAF_BYTES,
                                                  rate=RateLimit(rate or DEFAULT_READ_RATE))}
    except Exception as error:
        return {"recorded": False, "error": f"{type(error).__name__}: {error}"}


def create(path: Path, expected: dict) -> sqlite3.Connection:
    db = sqlite3.connect(path)
    db.executescript("""
    PRAGMA page_size=8192;
    CREATE TABLE IF NOT EXISTS articles(entry_index INTEGER PRIMARY KEY, payload BLOB NOT NULL);
    CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
    """)
    row = db.execute("SELECT value FROM meta WHERE key='binding'").fetchone()
    if row is None:
        with db:
            db.execute("INSERT INTO meta VALUES('binding',?)",
                       (json.dumps(expected, sort_keys=True, separators=(",", ":")),))
    elif json.loads(row[0]) != expected:
        db.close()
        raise ValueError("an existing build in this directory belongs to another generation")
    return db
