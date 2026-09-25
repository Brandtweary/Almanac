"""The content service's view of integrity state: what may be served, and what to say about it.

Quarantine is an overlay. It never edits `active.json`, a generation manifest or a
receipt: damage is a fact about bytes, not a library configuration choice, and editing
the active union would reshape it and change its qualification. Instead every read of
an archive consults this view first.

- Document loss: an entry whose cluster touches a quarantined leaf is refused.
- Index loss: a quarantined leaf holding a search index withdraws lexical search over
  that archive; reads and dense search continue.
- Structural loss: a quarantined leaf in the tables the reader navigates by, a resized
  or missing artifact, or damage the stored map cannot localise withdraws the archive.

A leaf mended and awaiting reload carries the epoch its mend advanced to. A reader
opened before that epoch may hold the decoded damaged cluster in libzim's cache, so it
refuses everything the leaf touches until it is reopened; a reader opened after it
serves normally. The epoch comparison is per reader, which keeps the rule exact however
many processes serve the library.

With no integrity state at all, nothing is quarantined and every archive reports that
it has not been admitted, never that it is healthy.
"""
from __future__ import annotations

import json
import os
import sqlite3
import threading
import time
from collections import OrderedDict
from datetime import datetime, timezone
from pathlib import Path

from .state import (DAMAGED, MENDING, MISSING, OK, PENDING_RELOAD, QUARANTINED, SIZE_MISMATCH, SUSPECT, UNREPAIRABLE,
                    WITHDRAWN, WRITE_FAILED, DEFAULT_WINDOW_SECONDS)
from .tree import HASH_BYTES, leaf_hash, leaf_span, root, split_leaves
from . import zimmap

COVERAGE_REFRESH_SECONDS = 60
VERIFIED_CACHE_LEAVES = 4096
WITHDRAWING_ARTIFACT_STATES = {SIZE_MISMATCH, MISSING, WITHDRAWN}
# What a read-path re-hash reports. `verified` and `refused` are the two outcomes of a
# re-hash that ran; `not_admitted` means there is nothing to check against. Every other
# outcome names why the re-hash did not run on an admitted archive, and a reader is
# told, because a read that was not checked must never pass for one that was.
VERIFIED, REFUSED, NOT_ADMITTED = "verified", "refused", "not_admitted"
UNMAPPED = "unmapped"
MANIFEST_UNVERIFIED = "manifest_unverified"
LEAF_LIST_UNAVAILABLE = "leaf_list_unavailable"


def _iso(ns):
    return None if ns is None else datetime.fromtimestamp(ns / 1e9, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


class ArchiveView:
    """One Tier A artifact as the service must treat it right now."""

    def __init__(self, row, quarantined, mended, epoch, structure):
        self.row, self.quarantined, self.mended, self.epoch = row, quarantined, mended, epoch
        self.structure = structure
        self.id = row["id"]
        self.leaf_bytes, self.size = row["leaf_bytes"], row["bytes"]
        self.classes = {index: self.classify(index) for index in set(quarantined) | set(mended)}
        self.withdrawn_reason = None
        if row["status"] in WITHDRAWING_ARTIFACT_STATES:
            self.withdrawn_reason = row["status"]
        elif any(self.classes[index] == "structural" for index in quarantined):
            self.withdrawn_reason = "structural_damage"
        self.lexical_withdrawn = self.withdrawn or any(self.classes[index] in ("index", "structural")
                                                       for index in quarantined)

    def classify(self, index):
        if self.structure is None:
            # Damage that cannot be localised costs the whole archive, never a guess.
            return "structural"
        start, end = leaf_span(index, self.size, self.leaf_bytes)
        verdict = self.structure.classify(start, end)
        return verdict["class"] or "unmapped"

    @property
    def withdrawn(self):
        return self.withdrawn_reason is not None

    def blocked(self, entry, reader_epoch):
        """Why this reader may not serve an entry, or None when it may."""
        if self.withdrawn:
            return self.withdrawn_reason
        stale = {index for index, epoch in self.mended.items() if epoch > reader_epoch}
        considered = set(self.quarantined) | stale
        if not considered:
            return None
        # A quarantined structural leaf has already withdrawn the archive above, so a
        # structural leaf here is one mended since this reader opened.
        if any(self.classes[index] == "structural" for index in stale):
            return "pending_reload"
        touching = considered.intersection(self.structure.entry_leaves(entry, self.leaf_bytes))
        if not touching:
            return None
        statuses = {self.quarantined.get(index) for index in touching}
        if statuses == {None}:
            return "pending_reload"
        return "unrepairable" if UNREPAIRABLE in statuses else "damaged"


def message(reason, title):
    return {"unrepairable": f"This document in {title} is damaged and no available source can repair it",
            "damaged": f"This document in {title} is damaged; repair is pending",
            "pending_reload": f"This document in {title} was repaired and is being reloaded; retry shortly",
            "structural_damage": f"The archive {title} is damaged in its internal tables and is withdrawn until repaired",
            SIZE_MISMATCH: f"The archive {title} does not have its recorded size and is withdrawn",
            MISSING: f"The archive {title} is missing from the installation",
            WITHDRAWN: f"The archive {title} is withdrawn"}.get(reason, f"{title} is damaged")


class Overlay:
    def __init__(self, store_root: Path):
        self.directory = Path(store_root) / "integrity"
        self.path = self.directory / "state.sqlite"
        self.lock = threading.RLock()
        self.db = None
        self.identity = None
        self.version = None
        self.snapshot = None
        self.maps = {}
        self.views = {}
        self.coverage_cache = {}
        self.leaf_lists = {}
        self.verified = OrderedDict()

    # -- state loading ----------------------------------------------------------------

    def _connection(self):
        try:
            stat = self.path.stat()
        except FileNotFoundError:
            if self.db is not None:
                self.db.close()
            self.db, self.identity = None, None
            return None
        identity = (stat.st_dev, stat.st_ino)
        if self.db is None or identity != self.identity:
            if self.db is not None:
                self.db.close()
            self.db = sqlite3.connect(self.path, check_same_thread=False, isolation_level=None, timeout=5)
            self.db.execute("PRAGMA busy_timeout=5000")
            self.identity, self.version = identity, None
        return self.db

    def refresh(self):
        """Reload only when a connection has committed; one pragma read otherwise.

        `data_version` moves only for commits by other connections, so this overlay's
        own two writes clear `version` themselves.
        """
        with self.lock:
            db = self._connection()
            if db is None:
                if self.snapshot is not None or self.version is not None:
                    self.snapshot, self.views, self.coverage_cache, self.version = None, {}, {}, None
                return None
            version = db.execute("PRAGMA data_version").fetchone()[0]
            if version != self.version or self.snapshot is None:
                self.snapshot = self._load(db)
                self.version, self.views = version, {}
            return self.snapshot

    def _load(self, db):
        names = [column[0] for column in db.execute("SELECT * FROM artifact LIMIT 0").description]
        artifacts = {row[0]: dict(zip(names, row)) for row in db.execute("SELECT * FROM artifact")}
        quarantined, mended = {}, {}
        marks = ",".join("?" * len(QUARANTINED))
        for artifact, index, status in db.execute(f"SELECT artifact, leaf, status FROM leaf WHERE status IN ({marks})",
                                                  QUARANTINED):
            quarantined.setdefault(artifact, {})[index] = status
        for artifact, index, epoch in db.execute("SELECT artifact, leaf, epoch FROM leaf WHERE epoch > 0"):
            mended.setdefault(artifact, {})[index] = epoch
        epochs = dict(db.execute("SELECT artifact, epoch FROM reader_epoch"))
        dense = {generation: bool(ok) for generation, ok in
                 db.execute("SELECT generation, ok FROM generation_check WHERE kind='dense'")}
        identity = {generation: bool(ok) for generation, ok in
                    db.execute("SELECT generation, ok FROM generation_check WHERE kind='identity'")}
        meta = {key: json.loads(value) for key, value in db.execute("SELECT key, value FROM meta")}
        return {"artifacts": artifacts, "quarantined": quarantined, "mended": mended, "epochs": epochs,
                "dense": dense, "identity": identity, "meta": meta}

    def _map(self, row):
        if not row["map_sha256"]:
            return None
        key = (row["id"], row["map_sha256"])
        if key not in self.maps:
            try:
                self.maps[key] = zimmap.StructureMap(self.directory / "structure" / (row["id"] + ".map"),
                                                     row["map_sha256"])
            except (OSError, ValueError, zimmap.MapError):
                self.maps[key] = None
        return self.maps[key]

    # -- what the reader asks -----------------------------------------------------------

    def epoch(self, artifact_id) -> int:
        snapshot = self.refresh()
        return 0 if snapshot is None else snapshot["epochs"].get(artifact_id, 0)

    def archive(self, artifact_id):
        """The view of one Tier A artifact, or None when it was never admitted here."""
        with self.lock:
            snapshot = self.refresh()
            if snapshot is None:
                return None
            row = snapshot["artifacts"].get(artifact_id)
            if row is None or row["tier"] != "A":
                return None
            if artifact_id not in self.views:
                quarantined = snapshot["quarantined"].get(artifact_id, {})
                mended = snapshot["mended"].get(artifact_id, {})
                # A missing or unverifiable map leaves `structure` None, and damage that
                # cannot be localised then withdraws the archive rather than being guessed at.
                self.views[artifact_id] = ArchiveView(row, quarantined, mended, snapshot["epochs"].get(artifact_id, 0),
                                                      self._map(row))
            return self.views[artifact_id]

    def spans_usable(self, generation, reader_epoch) -> bool:
        """Whether a generation's precomputed spans may still be read."""
        snapshot = self.refresh()
        if snapshot is None:
            return True
        artifact_id = "spans-" + generation
        row = snapshot["artifacts"].get(artifact_id)
        if row is None:
            return True
        if row["status"] != "ok" or snapshot["quarantined"].get(artifact_id):
            return False
        return snapshot["epochs"].get(artifact_id, 0) <= reader_epoch

    def dense_degraded(self, generation) -> bool:
        snapshot = self.refresh()
        return snapshot is not None and snapshot["dense"].get(generation) is False

    # -- the two writes the service makes -------------------------------------------------

    def acknowledge(self, artifact_id, loaded_epoch):
        """Record that a reader opened at `loaded_epoch` is serving, lifting the pending label."""
        snapshot = self.refresh()
        if snapshot is None or not any(epoch <= loaded_epoch for index, epoch in
                                       snapshot["mended"].get(artifact_id, {}).items()):
            return
        with self.lock:
            db = self._connection()
            if db is None:
                return
            try:
                db.execute("BEGIN IMMEDIATE")
                rows = db.execute("SELECT leaf FROM leaf WHERE artifact=? AND status=? AND epoch<=?",
                                  (artifact_id, PENDING_RELOAD, loaded_epoch)).fetchall()
                for (index,) in rows:
                    db.execute("UPDATE leaf SET status=? WHERE artifact=? AND leaf=?", (OK, artifact_id, index))
                    db.execute("INSERT INTO event VALUES(?,?,?,?,?)", (time.time_ns(), artifact_id, index,
                               "reload_acknowledged", json.dumps({"epoch": loaded_epoch})))
                db.execute("COMMIT")
                self.version = None
            except sqlite3.Error:
                try:
                    db.execute("ROLLBACK")
                except sqlite3.Error:
                    pass

    def mark_suspect(self, artifact_id, index, reason):
        """A read-path hash mismatch: quarantine at once, and leave the medium's verdict to the scrub."""
        with self.lock:
            db = self._connection()
            if db is None:
                return
            db.execute("BEGIN IMMEDIATE")
            try:
                db.execute("UPDATE leaf SET status=? WHERE artifact=? AND leaf=? AND status NOT IN (?,?,?,?)",
                           (SUSPECT, artifact_id, index, DAMAGED, UNREPAIRABLE, MENDING, WRITE_FAILED))
                db.execute("INSERT INTO event VALUES(?,?,?,?,?)",
                           (time.time_ns(), artifact_id, index, "read_path_mismatch", json.dumps({"reason": reason})))
                db.execute("COMMIT")
                self.version = None
            except sqlite3.Error:
                db.execute("ROLLBACK")
                raise

    # -- read-path verification -----------------------------------------------------------

    def leaf_hashes(self, artifact_id):
        """An artifact's committed leaf hashes, reproduced against the root this installation verified.

        Returns `(leaves, None)`, or `(None, reason)` naming why they are unavailable.
        """
        snapshot = self.refresh()
        row = None if snapshot is None else snapshot["artifacts"].get(artifact_id)
        if row is None:
            return None, NOT_ADMITTED
        manifest = snapshot["meta"].get("manifest")
        if not manifest or not manifest.get("ok"):
            return None, MANIFEST_UNVERIFIED
        path = Path(manifest["dir"]) / "leaves" / (artifact_id + ".leaves")
        try:
            stat = path.stat()
        except OSError:
            return None, LEAF_LIST_UNAVAILABLE
        key = (artifact_id, stat.st_mtime_ns, stat.st_size, row["root"])
        cached = self.leaf_lists.get(artifact_id)
        if cached is not None and cached[0] == key:
            return cached[1], None
        try:
            raw = path.read_bytes()
            leaves = split_leaves(raw)
        except (OSError, ValueError):
            return None, LEAF_LIST_UNAVAILABLE
        if len(raw) != HASH_BYTES * row["leaf_count"] or root(leaves).hex() != row["root"]:
            return None, LEAF_LIST_UNAVAILABLE
        self.leaf_lists[artifact_id] = (key, leaves)
        return leaves, None

    def read_verification(self, artifact_id):
        """Whether reads of an archive are re-hashed now: `active`, or the outcome naming why not."""
        view = self.archive(artifact_id)
        if view is None:
            return NOT_ADMITTED
        if view.structure is None:
            return UNMAPPED
        leaves, reason = self.leaf_hashes(artifact_id)
        return "active" if leaves is not None else reason

    def verify_entry(self, artifact_id, path, entry, window_seconds=None):
        """Re-hash the leaves an entry decodes from before its text is returned to a reader.

        Reads go through the page cache, deliberately: this checks the bytes libzim is
        about to decode, which is what a person will see. Each leaf is re-hashed at most
        once per scrub window. A mismatch evicts the cached pages, quarantines the leaf
        as suspect for the scrub to confirm on the medium, and refuses the entry.
        Returns `verified` or `refused` when the re-hash ran, `not_admitted` when there is
        nothing to check against, and otherwise the reason it could not run.
        """
        view = self.archive(artifact_id)
        if view is None:
            return NOT_ADMITTED
        if view.structure is None:
            return UNMAPPED
        leaves, reason = self.leaf_hashes(artifact_id)
        if leaves is None:
            return reason
        window = window_seconds or int(((self.snapshot or {}).get("meta") or {}).get("window_seconds",
                                                                                       DEFAULT_WINDOW_SECONDS))
        now = time.monotonic()
        wanted = list(view.structure.entry_leaves(entry, view.leaf_bytes))
        pending = []
        with self.lock:
            for index in wanted:
                stamp = self.verified.get((artifact_id, index))
                if stamp is None or now - stamp > window:
                    pending.append(index)
        if not pending:
            return VERIFIED
        descriptor = os.open(path, os.O_RDONLY | os.O_CLOEXEC)
        try:
            for index in pending:
                start, stop = leaf_span(index, view.size, view.leaf_bytes)
                data = os.pread(descriptor, stop - start, start)
                if leaf_hash(data) != leaves[index]:
                    os.posix_fadvise(descriptor, start, stop - start, os.POSIX_FADV_DONTNEED)
                    try:
                        self.mark_suspect(artifact_id, index, "read_path_hash_mismatch")
                    except sqlite3.Error:
                        # The refusal never depends on recording it; the scrub reads
                        # every leaf from the medium regardless.
                        pass
                    return REFUSED
                with self.lock:
                    self.verified[(artifact_id, index)] = now
                    self.verified.move_to_end((artifact_id, index))
                    while len(self.verified) > VERIFIED_CACHE_LEAVES:
                        self.verified.popitem(last=False)
        finally:
            os.close(descriptor)
        return VERIFIED

    # -- reporting --------------------------------------------------------------------------

    def coverage(self, artifact_id):
        """The per-archive integrity block every coverage response carries."""
        with self.lock:
            snapshot = self.refresh()
            if snapshot is None or artifact_id not in snapshot["artifacts"]:
                return {"admitted": False, "verified_fraction": 0.0, "withdrawn": False, "lexical_withdrawn": False,
                        "note": "not admitted: no leaf list exists for this archive, so nothing about its bytes is verified"}
            # Counts are reused for a minute while the quarantine, the epochs and the
            # artifact's own status stand still: a scrub commits verdicts continuously,
            # and recounting a whole archive for every response would cost the service
            # far more than the staleness of a verified fraction costs a reader.
            signature = (tuple(sorted(snapshot["quarantined"].get(artifact_id, {}).items())),
                         snapshot["epochs"].get(artifact_id, 0), snapshot["artifacts"][artifact_id]["status"],
                         json.dumps(snapshot["meta"].get("manifest"), sort_keys=True))
            cached = self.coverage_cache.get(artifact_id)
            if cached is not None and cached[0] == signature and time.monotonic() - cached[1] < COVERAGE_REFRESH_SECONDS:
                return {**cached[2], "read_verification": self.read_verification(artifact_id)}
            db = self._connection()
            row = snapshot["artifacts"][artifact_id]
            meta = snapshot["meta"]
            window = int(meta.get("window_seconds", DEFAULT_WINDOW_SECONDS))
            floor = time.time_ns() - window * 1_000_000_000
            counts = dict(db.execute("SELECT status, count(*) FROM leaf WHERE artifact=? GROUP BY status", (artifact_id,)))
            fresh = db.execute("SELECT count(*) FROM leaf WHERE artifact=? AND status=? AND last_verified_ns>=?",
                               (artifact_id, OK, floor)).fetchone()[0]
            completed = db.execute("SELECT max(completed_ns) FROM pass WHERE artifact=?", (artifact_id,)).fetchone()[0]
            probes = db.execute("SELECT source, ok FROM source_probe WHERE artifact=? AND source NOT LIKE 'successor:%'",
                                (artifact_id,)).fetchall()
            successor = db.execute("SELECT ok, detail FROM source_probe WHERE artifact=? AND source LIKE 'successor:%'",
                                   (artifact_id,)).fetchall()
            documents, complete = set(), True
            for index in snapshot["quarantined"].get(artifact_id, {}):
                found = db.execute("SELECT detail FROM localization WHERE artifact=? AND leaf=?",
                                   (artifact_id, index)).fetchone()
                entries = json.loads(found[0]).get("entries") if found else None
                if entries is None:
                    complete = False
                else:
                    documents.update(entries)
            view = self.archive(artifact_id)
            manifest = meta.get("manifest") or {}
            readings = [(bool(ok), json.loads(detail) if detail else {}) for ok, detail in successor]
            block = {"admitted": True, "verified_fraction": round(fresh / row["leaf_count"], 6) if row["leaf_count"] else 0.0,
                     "unverified_leaves": row["leaf_count"] - fresh,
                     "damaged_leaves": sum(counts.get(state, 0) for state in (SUSPECT, DAMAGED, MENDING, WRITE_FAILED)),
                     "unrepairable_leaves": counts.get(UNREPAIRABLE, 0),
                     "pending_reload_leaves": counts.get(PENDING_RELOAD, 0),
                     "damaged_documents": len(documents) if complete else None,
                     "lexical_withdrawn": bool(view and view.lexical_withdrawn),
                     "withdrawn": bool(view and view.withdrawn),
                     "withdrawn_reason": view.withdrawn_reason if view else None,
                     "last_full_pass": _iso(completed),
                     "network_sources_available": sum(ok for _source, ok in probes) if probes else None,
                     "upstream": None if not readings else {
                         "reachable": any(ok for ok, _detail in readings),
                         "successor": next((detail.get("successor") for ok, detail in readings
                                            if ok and detail.get("successor")), None),
                         "installed_edition_listed": all(detail.get("pinned_listed", True)
                                                         for ok, detail in readings if ok)},
                     "manifest": "verified" if manifest.get("ok") else "damaged" if manifest else "unchecked",
                     "corpus_root": manifest.get("corpus_root") if manifest.get("ok") else None}
            self.coverage_cache[artifact_id] = (signature, time.monotonic(), block)
            # Read outside the cache: a moved manifest directory turns the read-path
            # re-hash off at once, and the label has to say so at once.
            return {**block, "read_verification": self.read_verification(artifact_id)}

    def generation_flags(self, generation):
        snapshot = self.refresh()
        if snapshot is None:
            return {}
        flags = {}
        if snapshot["identity"].get(generation) is False:
            flags["generation_identity"] = "mismatch"
        if snapshot["dense"].get(generation) is False:
            flags["dense_validation"] = "failed"
        spans = snapshot["artifacts"].get("spans-" + generation)
        if spans is not None:
            flags["spans_integrity"] = ("withdrawn" if spans["status"] != "ok" or snapshot["quarantined"].get(spans["id"])
                                        else "admitted")
        return flags
