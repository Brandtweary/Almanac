"""Owner-only staged ingestion with disk-backed manifests and extraction receipts."""
from __future__ import annotations
import fcntl
import hashlib
import json
import os
from pathlib import Path
import shutil
import sqlite3
import tempfile
import traceback
import uuid
from .extract import extract, segment
from .models import Block, Document, Profile, digest
from .store import Store, CatalogIdentifiers, atomic_json, build_catalog


def zim_documents(template: Document):
    """Stream article manifests, preserving original archive digest and native paths."""
    from libzim.reader import Archive
    archive = Archive(template.original_path)
    native = archive.has_fulltext_index
    for index in range(archive.entry_count):
        entry = archive._get_entry_by_id(index)
        if entry.is_redirect:
            continue
        item = entry.get_item()
        if item.mimetype not in {"text/html", "application/xhtml+xml"}:
            continue
        article_id = digest([template.work_id, entry.path])
        yield template.model_copy(update={"document_id": article_id, "title": entry.title,
            "article_path": entry.path, "zim_native_index": native})


def inspection_for(document, validation):
    override = validation.get(document.document_id)
    if override is not None:
        if (override.get("sha256") != document.sha256 or
                override.get("extraction_revision") != document.extraction_revision):
            raise ValueError("document inspection identity mismatch")
        evidence = override
    else:
        evidence = validation.get("adapters", {}).get(document.media_type + ":" + document.extraction_revision, {})
    if evidence.get("checked") is not True or not evidence.get("receipt"):
        raise ValueError("representative extraction inspection required: " + document.media_type)
    return evidence


def publish_original(store, source, sha256, managed):
    target = store.root / "originals" / sha256
    target.parent.mkdir(parents=True, exist_ok=True)
    if target.exists():
        receipt_path = target.with_suffix(".receipt.json")
        stat = target.stat()
        receipt = json.loads(receipt_path.read_text()) if receipt_path.exists() else {}
        if receipt.get("size") != stat.st_size or receipt.get("mtime_ns") != stat.st_mtime_ns:
            with target.open("rb") as stream:
                if hashlib.file_digest(stream, "sha256").hexdigest() != sha256:
                    raise ValueError("stored original integrity mismatch")
            atomic_json(receipt_path, {"sha256": sha256, "size": stat.st_size, "mtime_ns": stat.st_mtime_ns})
        return target
    temporary = target.with_name(target.name + "." + uuid.uuid4().hex + ".building")
    try:
        if managed:
            try:
                os.link(source, temporary)
            except OSError as error:
                if error.errno != 18:  # EXDEV: managed objects on another filesystem require a copy.
                    raise
                shutil.copyfile(source, temporary)
        else:
            shutil.copyfile(source, temporary)
        with temporary.open("rb") as stream:
            if hashlib.file_digest(stream, "sha256").hexdigest() != sha256:
                raise ValueError("source changed during immutable publication")
            os.fsync(stream.fileno())
        os.replace(temporary, target)
        stat = target.stat()
        atomic_json(target.with_suffix(".receipt.json"), {"sha256": sha256, "size": stat.st_size, "mtime_ns": stat.st_mtime_ns})
    finally:
        temporary.unlink(missing_ok=True)
    return target


async def build(store: Store, documents, profile: Profile, dense, tokenizer,
                validation: dict, *, assets_path: str | None = None, activate: bool = True,
                managed_originals: bool = False, category: str = ""):
    """Stream manifests, resume durable stages, atomically activate validated indexes.

    `validation.adapters` keys are `<media_type>:<extraction_revision>`, with checked/receipt
    identifying representative layout fixtures. Optional document overrides additionally bind
    sha256/extraction_revision. All documents still undergo automated integrity/parse checks.
    `managed_originals` allows hardlinks only from an installer's immutable verified objects.
    `category` names the part of the library these works are listed under; it describes the
    installation rather than the index, so it stays out of the generation identity and can be
    renamed without rebuilding anything.
    """
    # Spooling permits millions of archive articles without an in-memory document manifest.
    with tempfile.TemporaryDirectory(prefix="ingestion-", dir=store.root) as scratch:
        inputs = sqlite3.connect(Path(scratch) / "inputs.sqlite")
        inputs.execute("CREATE TABLE inputs(id TEXT PRIMARY KEY,data TEXT NOT NULL)")
        fingerprint = hashlib.sha256(profile.index_fingerprint.encode())
        if profile.vector_datatype != "float32":
            fingerprint.update(("\0vector-datatype:" + profile.vector_datatype).encode())
        count = 0
        with inputs:
            for document in documents:
                encoded = json.dumps(document.model_dump(exclude={"original_path"}), sort_keys=True, separators=(",", ":"))
                fingerprint.update(encoded.encode() + b"\n")
                inputs.execute("INSERT INTO inputs VALUES(?,?)", (document.document_id, document.model_dump_json()))
                count += 1
        if not count:
            inputs.close()
            raise ValueError("ingestion needs nonempty unique document identities")
        generation = fingerprint.hexdigest()
        directory = store.directory(generation)
        directory.mkdir(parents=True, exist_ok=True)
        with (directory / "writer.lock").open("a") as lock:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                inputs.close()
                raise RuntimeError("another ingestion owns this generation") from None
            manifest_path = directory / "manifest.json"
            manifest = json.loads(manifest_path.read_text()) if manifest_path.exists() else {
                "generation": generation, "stage": "acquired", "profile_fingerprint": profile.fingerprint, "index_fingerprint": profile.index_fingerprint,
                "vector_datatype": profile.vector_datatype,
                "profile_id": profile.profile_id, "packs": [], "document_count": count,
                "passage_count": 0, "embedded_passages": 0, "extraction_failures": 0}
            # The category mirrors this invocation, including its absence, and is persisted
            # before the activated-generation shortcut so a renamed one survives it.
            if manifest.get("category", "") != category:
                manifest["category"] = category
                atomic_json(manifest_path, manifest)
            if manifest["stage"] == "active":
                if activate:
                    store.activate(generation)
                inputs.close()
                return generation
            atomic_json(manifest_path, manifest)
            extraction_cache = sqlite3.connect(store.root / "extraction-cache.sqlite", timeout=30)
            extraction_cache.execute("CREATE TABLE IF NOT EXISTS extracted(key TEXT PRIMARY KEY,data TEXT NOT NULL)")
            extraction_cache.commit()
            receipts = sqlite3.connect(directory / "extraction.sqlite")
            receipts.executescript("""CREATE TABLE IF NOT EXISTS documents(id TEXT PRIMARY KEY,data TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS extracted(id TEXT PRIMARY KEY,data TEXT NOT NULL,status TEXT NOT NULL,error TEXT);
                CREATE TABLE IF NOT EXISTS originals(path TEXT,sha256 TEXT,PRIMARY KEY(path,sha256));""")

            def checkpoint(stage, **extra):
                manifest.update(stage=stage, **extra)
                manifest.pop("failure", None)
                atomic_json(manifest_path, manifest)

            def docs():
                for row in receipts.execute("SELECT data FROM documents ORDER BY rowid"):
                    yield Document.model_validate_json(row[0])

            try:
                packs = set()
                # Disk table avoids repeated archive hashing and an unbounded RAM identity set.
                receipts.execute("DELETE FROM originals")
                with receipts:
                    for row in inputs.execute("SELECT data FROM inputs ORDER BY rowid"):
                        document = Document.model_validate_json(row[0])
                        source = Path(document.original_path)
                        found = receipts.execute("SELECT 1 FROM originals WHERE path=? AND sha256=?",
                                                 (str(source), document.sha256)).fetchone()
                        if not found:
                            with source.open("rb") as stream:
                                if hashlib.file_digest(stream, "sha256").hexdigest() != document.sha256:
                                    raise ValueError("source checksum mismatch: " + document.document_id)
                            publish_original(store, source, document.sha256, managed_originals)
                            receipts.execute("INSERT INTO originals VALUES(?,?)", (str(source), document.sha256))
                        canonical = document.model_copy(update={"original_path": "originals/" + document.sha256})
                        receipts.execute("INSERT OR REPLACE INTO documents VALUES(?,?)", (document.document_id, canonical.model_dump_json()))
                        packs.add(document.pack_id)
                stages = ["acquired", "verified", "extracted", "lexical-indexed", "embedded", "validated", "active"]
                if stages.index(manifest["stage"]) < 1:
                    checkpoint("verified", packs=sorted(packs))
                if stages.index(manifest["stage"]) < 2:
                    failures = 0
                    zim_archives = {}
                    for document in docs():
                        prior = receipts.execute("SELECT status FROM extracted WHERE id=?", (document.document_id,)).fetchone()
                        if prior and prior[0] == "complete":
                            continue
                        try:
                            cache_key = digest([document.sha256, document.article_path, document.media_type, document.extraction_revision])
                            cached = extraction_cache.execute("SELECT data FROM extracted WHERE key=?", (cache_key,)).fetchone()
                            if cached:
                                raw = cached[0]
                            else:
                                blocks = extract(document.model_copy(update={"original_path": str(store.root / document.original_path)}),
                                                 assets_path, verified=True, zim_archives=zim_archives)
                                raw = json.dumps([b.model_dump() for b in blocks], ensure_ascii=False)
                                with extraction_cache:
                                    extraction_cache.execute("INSERT OR IGNORE INTO extracted VALUES(?,?)", (cache_key, raw))
                            with receipts:
                                receipts.execute("INSERT OR REPLACE INTO extracted VALUES(?,?,?,NULL)",
                                                 (document.document_id, raw, "complete"))
                        except Exception:
                            failures += 1
                            with receipts:
                                receipts.execute("INSERT OR REPLACE INTO extracted VALUES(?,?,?,?)",
                                                 (document.document_id, "[]", "failed", traceback.format_exc()))
                    manifest["extraction_failures"] = failures
                    if failures:
                        raise ValueError(f"{failures} extractions failed; generation is incomplete")
                    checkpoint("extracted")
                for document in docs():
                    inspection_for(document, validation)
                def all_passages():
                    for document in docs():
                        row = receipts.execute("SELECT data,status FROM extracted WHERE id=?", (document.document_id,)).fetchone()
                        if not row or row[1] != "complete":
                            raise ValueError("missing complete extraction receipt")
                        yield from segment(document, [Block.model_validate(b) for b in json.loads(row[0])], profile, tokenizer, generation)
                if stages.index(manifest["stage"]) < 3:
                    temporary = directory / "catalog.building.sqlite"
                    temporary.unlink(missing_ok=True)
                    build_catalog(temporary, docs(), all_passages())
                    temporary.replace(directory / "catalog.sqlite")
                    count = len(CatalogIdentifiers(store, generation))
                    if count == 0:
                        raise ValueError("empty generation")
                    checkpoint("lexical-indexed", passage_count=count)
                if stages.index(manifest["stage"]) < 4:
                    await dense.create(generation)
                    batch, completed = [], manifest["embedded_passages"]
                    for index, passage in enumerate(store.passages(generation)):
                        if index < completed:
                            continue
                        batch.append(passage)
                        if len(batch) == profile.embedding_batch:
                            await dense.put(generation, batch)
                            completed += len(batch)
                            manifest["embedded_passages"] = completed
                            atomic_json(manifest_path, manifest)
                            batch = []
                    if batch:
                        await dense.put(generation, batch)
                        manifest["embedded_passages"] = completed + len(batch)
                        atomic_json(manifest_path, manifest)
                    checkpoint("embedded")
                if stages.index(manifest["stage"]) < 5:
                    ids = CatalogIdentifiers(store, generation)
                    if len(ids) != manifest["passage_count"]:
                        raise ValueError("passage count mismatch")
                    with ids:
                        await dense.validate(generation, ids)
                    with store.connect(generation) as db:
                        missing = db.execute("SELECT id FROM documents d WHERE NOT EXISTS(SELECT 1 FROM passages p WHERE p.document_id=d.id) LIMIT 1").fetchone()
                    if missing:
                        raise ValueError("document has no readable passages")
                    checkpoint("validated", extraction_validation=validation)
                if activate:
                    store.activate(generation)
                return generation
            except BaseException as error:
                manifest["failure"] = {"type": type(error).__name__, "message": str(error), "traceback": traceback.format_exc()}
                atomic_json(manifest_path, manifest)
                raise
            finally:
                receipts.close()
                extraction_cache.close()
                inputs.close()
