"""Immutable SQLite generations and atomic active-pointer publication."""
from __future__ import annotations
import contextlib
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import sqlite3
import uuid
from .models import ContentError, Document, Passage, Profile

HEX = re.compile(r"^[a-f0-9]{64}$")
HANDLE = re.compile(r"^p:([a-f0-9]{64}):([a-f0-9]{64})$")


def atomic_json(path: Path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_name(path.name + "." + uuid.uuid4().hex + ".tmp")
    try:
        with temp.open("w") as stream:
            json.dump(value, stream, ensure_ascii=False, sort_keys=True)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temp, path)
        fd = os.open(path.parent, os.O_DIRECTORY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)
    finally:
        temp.unlink(missing_ok=True)


class Store:
    def __init__(self, root: Path):
        self.root = Path(root).resolve()
        self.root.mkdir(parents=True, exist_ok=True)
        self._native_readers = {}

    def native(self, generation):
        from .native import KIND, NativeReader
        if self.manifest(generation).get("kind") != KIND:
            return None
        if generation not in self._native_readers:
            self._native_readers[generation] = NativeReader(self, generation)
        return self._native_readers[generation]

    def active_generations(self):
        try:
            pointer = json.loads((self.root / "active.json").read_text())
        except FileNotFoundError:
            raise ContentError("corpus_unready", "No active reference generation") from None
        generations = list(dict.fromkeys([pointer["generation"], *pointer.get("additional_generations", [])]))
        for generation in generations:
            if self.manifest(generation).get("stage") != "active":
                raise ContentError("corpus_unready", "A reference generation is not activated")
        return generations

    def include_active(self, generation):
        with (self.root / "active.lock").open("a") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            try:
                prior = self.active_generations()
            except ContentError as error:
                if error.code != "corpus_unready":
                    raise
                prior = []
            packs = set(self.manifest(generation).get("packs", []))
            retained = []
            for old in prior:
                old_packs = set(self.manifest(old).get("packs", []))
                if packs & old_packs and not old_packs <= packs:
                    raise ValueError("Partial replacement of a multi-pack catalog requires rebuilding its remaining packs")
                if old != generation and not old_packs <= packs:
                    retained.append(old)
            atomic_json(self.root / "active.json", {"generation": generation,
                "additional_generations": retained})

    def directory(self, generation):
        if not isinstance(generation, str) or not HEX.fullmatch(generation):
            raise ContentError("invalid_handle", "Invalid generation identifier", 400)
        return self.root / "generations" / generation

    def active(self):
        try:
            generation = json.loads((self.root / "active.json").read_text())["generation"]
            manifest = self.manifest(generation)
        except FileNotFoundError:
            raise ContentError("corpus_unready", "No active reference generation") from None
        if manifest.get("stage") != "active":
            raise ContentError("corpus_unready", "Reference generation is not activated")
        return generation

    def manifest(self, generation):
        try:
            return json.loads((self.directory(generation) / "manifest.json").read_text())
        except FileNotFoundError:
            raise ContentError("unavailable_version", "This source generation is unavailable", 410) from None

    @contextlib.contextmanager
    def connect(self, generation):
        path = self.directory(generation) / "catalog.sqlite"
        if not path.is_file():
            raise ContentError("unavailable_version", "This source generation is unavailable", 410)
        db = sqlite3.connect(path.as_uri() + "?mode=ro", uri=True)
        db.row_factory = sqlite3.Row
        try:
            yield db
        finally:
            db.close()

    def document(self, generation, document_id):
        native = self.native(generation)
        if native is not None:
            return native.document(document_id)
        with self.connect(generation) as db:
            row = db.execute("SELECT data FROM documents WHERE id=?", (document_id,)).fetchone()
        if not row:
            raise ContentError("unknown_document", "Unknown document in this generation", 404)
        return Document.model_validate_json(row[0])

    def passage(self, generation, passage_id):
        match = HANDLE.fullmatch(passage_id)
        if not match:
            raise ContentError("invalid_handle", "Malformed passage handle", 400)
        if match[1] != generation:
            raise ContentError("generation_mismatch", "Passage belongs to a different generation", 409)
        native = self.native(generation)
        if native is not None:
            return native.passage(passage_id)
        with self.connect(generation) as db:
            row = db.execute("SELECT data FROM passages WHERE id=?", (passage_id,)).fetchone()
        if not row:
            raise ContentError("unknown_passage", "Unknown passage in this generation", 404)
        return Passage.model_validate_json(row[0])

    def passages(self, generation, document_id=None):
        native = self.native(generation)
        if native is not None:
            if document_id is None:
                raise ValueError("Native source reading requires a document identity")
            yield from native.passages(document_id)
            return
        with self.connect(generation) as db:
            sql, args = "SELECT data FROM passages", ()
            if document_id:
                sql += " WHERE document_id=?"
                args = (document_id,)
            for row in db.execute(sql + " ORDER BY document_id,ordinal", args):
                yield Passage.model_validate_json(row[0])

    def lexical(self, generation, query, limit, document_id=None):
        # User syntax is never interpolated as FTS syntax; identifiers and units remain terms.
        tokens = re.findall(r"[^\W_]+(?:[-./][^\W_]+)*", query, re.UNICODE)
        if not tokens:
            return []
        expression = " OR ".join('"' + token.replace('"', '""') + '"' for token in tokens)
        with self.connect(generation) as db:
            sql = "SELECT p.id,bm25(fts) score FROM fts JOIN passages p ON p.rowid=fts.rowid WHERE fts MATCH ?"
            args = [expression]
            if document_id:
                sql += " AND p.document_id=?"
                args.append(document_id)
            rows = db.execute(sql + " ORDER BY score,p.id LIMIT ?", (*args, limit)).fetchall()
        return [(row[0], row[1]) for row in rows]

    def zim_documents(self, generation, document_id=None):
        with self.connect(generation) as db:
            rows = db.execute("SELECT data FROM documents" + (" WHERE id=?" if document_id else ""),
                              (document_id,) if document_id else ())
            for row in rows:
                doc = Document.model_validate_json(row[0])
                if doc.zim_native_index:
                    yield doc

    def coverage(self, generation=None):
        inventory_path = self.root / "inventory.json"
        inventory = json.loads(inventory_path.read_text()) if inventory_path.exists() else {}
        generations = [generation] if generation else []
        if generation and (self.root / "active.json").exists():
            if json.loads((self.root / "active.json").read_text()).get("generation") == generation:
                generations = self.active_generations()
        active = sorted({pack for value in generations for pack in self.manifest(value).get("packs", [])})
        pending = set(inventory.get("pending_packs", []))
        exclusions = list(inventory.get("exclusions", []))
        for path in (self.root / "generations").glob("*/manifest.json"):
            job = json.loads(path.read_text())
            if job.get("stage") != "active":
                pending.update(job.get("packs", []))
                if job.get("extraction_failures"):
                    exclusions.append({"generation": job["generation"], "failed_documents": job["extraction_failures"],
                                       "reason": "extraction_failed", "stage": job["stage"]})
        native = []
        for value in generations:
            manifest = self.manifest(value)
            if manifest.get("kind") == "native-zim-article-v1":
                native.append({"generation": value, "pack_id": manifest["source"]["pack_id"],
                    "lexical": "native full text within declared source selection", "reader": "complete articles",
                    "dense_representation": manifest["dense_representation"], "dense_stage": manifest["dense_stage"],
                    "indexed_articles": manifest["indexed_articles"], "entry_cursor": manifest["entry_cursor"],
                    "entry_count": manifest.get("entry_count"), "canonical_html_articles": manifest.get("canonical_html_articles"),
                    "selection_policy": manifest["selection_policy"], "exclusions": manifest["exclusion_reasons"]})
        return {"active_packs": active, "pending_packs": sorted(pending.difference(active)),
                "content_only": inventory.get("content_only", []), "exclusions": exclusions, "native_archives": native}

    def activate(self, generation):
        manifest = self.manifest(generation)
        if manifest["stage"] not in {"validated", "active"}:
            raise ValueError("only validated generations can be activated")
        manifest["stage"] = "active"
        atomic_json(self.directory(generation) / "manifest.json", manifest)
        self.include_active(generation)


def build_catalog(path, documents, passages):
    db = sqlite3.connect(path)
    try:
        db.executescript("""
        CREATE TABLE documents(id TEXT PRIMARY KEY, data TEXT NOT NULL, original_path TEXT, article_path TEXT, native INTEGER);
        CREATE INDEX archive_articles ON documents(original_path,article_path);
        CREATE TABLE passages(id TEXT PRIMARY KEY,document_id TEXT NOT NULL,ordinal INTEGER NOT NULL,data TEXT NOT NULL);
        CREATE INDEX source_order ON passages(document_id,ordinal);
        CREATE VIRTUAL TABLE fts USING fts5(text,tokenize='unicode61');
        """)
        with db:
            db.executemany("INSERT INTO documents VALUES(?,?,?,?,?)", ((d.document_id, d.model_dump_json(), d.original_path, d.article_path, int(d.zim_native_index)) for d in documents))
            for p in passages:
                rowid = db.execute("INSERT INTO passages VALUES(?,?,?,?)", (p.passage_id, p.document_id, p.ordinal, p.model_dump_json())).lastrowid
                if not db.execute("SELECT native FROM documents WHERE id=?", (p.document_id,)).fetchone()[0]:
                    db.execute("INSERT INTO fts(rowid,text) VALUES(?,?)", (rowid, p.lexical_text))
        if db.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
            raise ValueError("lexical integrity check failed")
    finally:
        db.close()


class CatalogIdentifiers:
    """Disk-backed membership for full-corpus dense validation."""
    def __init__(self, store, generation):
        self.store, self.generation = store, generation
        self.db = None
    def __enter__(self):
        self.connection = self.store.connect(self.generation)
        self.db = self.connection.__enter__()
        return self
    def __exit__(self, *args):
        self.connection.__exit__(*args)
        self.db = None
    def __len__(self):
        with self.store.connect(self.generation) as db:
            return db.execute("SELECT count(*) FROM passages").fetchone()[0]
    def __contains__(self, pid):
        if self.db is not None:
            return self.db.execute("SELECT 1 FROM passages WHERE id=?", (pid,)).fetchone() is not None
        with self.store.connect(self.generation) as db:
            return db.execute("SELECT 1 FROM passages WHERE id=?", (pid,)).fetchone() is not None
    def __iter__(self):
        with self.store.connect(self.generation) as db:
            for row in db.execute("SELECT id FROM passages"):
                yield row[0]
