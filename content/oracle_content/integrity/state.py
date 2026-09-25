"""Local integrity state: what each leaf was last found to be, and everything that happened.

This store is machine-specific and never committed. It holds verdicts, cursors, the
event log and the reader epochs; the committed manifest holds what the bytes should
be. The content service reads it to decide what it may serve and writes only two
things: a read-path hash mismatch, and its acknowledgement of a reload.
"""
from __future__ import annotations

import contextlib
import json
import sqlite3
import time
from pathlib import Path

SCHEMA = """
PRAGMA journal_mode=WAL;
CREATE TABLE IF NOT EXISTS artifact(
    id TEXT PRIMARY KEY, tier TEXT NOT NULL, path TEXT NOT NULL, bytes INTEGER NOT NULL,
    leaf_bytes INTEGER NOT NULL, leaf_count INTEGER NOT NULL, root TEXT NOT NULL,
    status TEXT NOT NULL, generation TEXT, file_sha256 TEXT, map_sha256 TEXT,
    parity_path TEXT, parity_group INTEGER, parity_sha256 TEXT, detail TEXT);
CREATE TABLE IF NOT EXISTS leaf(
    artifact TEXT NOT NULL, leaf INTEGER NOT NULL, status TEXT NOT NULL,
    last_verified_ns INTEGER, fail_count INTEGER NOT NULL DEFAULT 0, epoch INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY(artifact, leaf));
CREATE INDEX IF NOT EXISTS leaf_status ON leaf(status);
CREATE INDEX IF NOT EXISTS leaf_mended ON leaf(epoch) WHERE epoch > 0;
CREATE TABLE IF NOT EXISTS pass(
    artifact TEXT NOT NULL, cursor INTEGER NOT NULL, started_ns INTEGER NOT NULL, completed_ns INTEGER);
CREATE TABLE IF NOT EXISTS event(
    ts INTEGER NOT NULL, artifact TEXT, leaf INTEGER, kind TEXT NOT NULL, detail TEXT);
CREATE INDEX IF NOT EXISTS event_leaf ON event(artifact, leaf, kind);
CREATE TABLE IF NOT EXISTS source_probe(
    artifact TEXT NOT NULL, source TEXT NOT NULL, ok INTEGER NOT NULL, checked_ns INTEGER NOT NULL,
    detail TEXT, PRIMARY KEY(artifact, source));
CREATE TABLE IF NOT EXISTS reader_epoch(artifact TEXT PRIMARY KEY, epoch INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS localization(
    artifact TEXT NOT NULL, leaf INTEGER NOT NULL, class TEXT NOT NULL, detail TEXT NOT NULL,
    PRIMARY KEY(artifact, leaf));
CREATE TABLE IF NOT EXISTS generation_check(
    generation TEXT NOT NULL, kind TEXT NOT NULL, ok INTEGER NOT NULL, checked_ns INTEGER NOT NULL,
    detail TEXT, PRIMARY KEY(generation, kind));
CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
"""

# Leaf states. `unverified` is the only state a leaf starts in: admission produced the
# list, so nothing has yet been checked against it.
UNVERIFIED, OK, SUSPECT, TRANSIENT = "unverified", "ok", "suspect", "transient"
DAMAGED, MENDING, PENDING_RELOAD = "damaged", "mending", "mended_pending_reload"
UNREPAIRABLE, WRITE_FAILED = "unrepairable", "write_failed"
LEAF_STATES = {UNVERIFIED, OK, SUSPECT, TRANSIENT, DAMAGED, MENDING, PENDING_RELOAD, UNREPAIRABLE, WRITE_FAILED}

# No byte decoded from a leaf in one of these states reaches a response. A leaf mended
# and awaiting reload is gated separately, by comparing its epoch with the reader's.
QUARANTINED = (SUSPECT, DAMAGED, MENDING, UNREPAIRABLE, WRITE_FAILED)
# What the mender takes up. `write_failed` is absent on purpose: a medium that did not
# hold one write is escalated to a person, never written to again in a loop.
MENDABLE = (DAMAGED, UNREPAIRABLE)
# States a scrub read may move to `ok` without a reload: nothing was quarantined, so
# no reader can hold a copy decoded from bad bytes.
PLAIN = (UNVERIFIED, OK, TRANSIENT)
# An unrepairable leaf is retried after this delay, doubling with each failed attempt
# since it last verified, up to the longest. An attempt from parity reads its whole group.
RETRY_FIRST_SECONDS = 3600
RETRY_LONGEST_SECONDS = 24 * 3600

# Artifact states. Anything but `ok` withdraws the whole artifact from service.
ARTIFACT_OK, SIZE_MISMATCH, MISSING = "ok", "size_mismatch", "missing"
MANIFEST_DAMAGED, WITHDRAWN = "manifest_damaged", "withdrawn"

DEFAULT_WINDOW_SECONDS = 7 * 24 * 3600


def now_ns() -> int:
    return time.time_ns()


class State:
    def __init__(self, directory: Path, *, readonly: bool = False):
        self.directory = Path(directory)
        self.path = self.directory / "state.sqlite"
        if readonly:
            self.db = sqlite3.connect(self.path.as_uri() + "?mode=ro", uri=True, check_same_thread=False,
                                      isolation_level=None, timeout=5)
        else:
            self.directory.mkdir(parents=True, exist_ok=True)
            self.db = sqlite3.connect(self.path, check_same_thread=False, isolation_level=None, timeout=30)
            self.db.executescript(SCHEMA)
        self.db.execute("PRAGMA busy_timeout=30000")

    def close(self):
        self.db.close()

    @contextlib.contextmanager
    def transaction(self):
        self.db.execute("BEGIN IMMEDIATE")
        try:
            yield self.db
        except BaseException:
            self.db.execute("ROLLBACK")
            raise
        self.db.execute("COMMIT")

    # -- metadata -----------------------------------------------------------------

    def get_meta(self, key, default=None):
        row = self.db.execute("SELECT value FROM meta WHERE key=?", (key,)).fetchone()
        return json.loads(row[0]) if row else default

    def set_meta(self, key, value):
        self.db.execute("INSERT OR REPLACE INTO meta VALUES(?,?)", (key, json.dumps(value)))

    def window_seconds(self) -> int:
        return int(self.get_meta("window_seconds", DEFAULT_WINDOW_SECONDS))

    # -- events -------------------------------------------------------------------

    def event(self, kind, artifact=None, leaf=None, **detail):
        self.db.execute("INSERT INTO event VALUES(?,?,?,?,?)",
                        (now_ns(), artifact, leaf, kind, json.dumps(detail, sort_keys=True) if detail else None))

    def events(self, artifact=None, kind=None):
        sql, args = "SELECT ts, artifact, leaf, kind, detail FROM event WHERE 1=1", []
        if artifact is not None:
            sql += " AND artifact=?"
            args.append(artifact)
        if kind is not None:
            sql += " AND kind=?"
            args.append(kind)
        return [{"ts": ts, "artifact": a, "leaf": leaf, "kind": k, "detail": json.loads(d) if d else {}}
                for ts, a, leaf, k, d in self.db.execute(sql + " ORDER BY rowid", args)]

    # -- artifacts ----------------------------------------------------------------

    def register(self, artifact_id, *, tier, path, size, leaf_bytes, leaf_count, root, generation=None,
                 file_sha256=None, map_sha256=None, parity_path=None, parity_group=None, parity_sha256=None):
        """Record an artifact and reset every leaf to `unverified`.

        Re-registering replaces the record, because a new registration is a new leaf
        list: no verdict reached against the previous list says anything about this one.
        """
        with self.transaction() as db:
            db.execute("INSERT OR REPLACE INTO artifact VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                       (artifact_id, tier, str(path), size, leaf_bytes, leaf_count, root, ARTIFACT_OK, generation,
                        file_sha256, map_sha256, parity_path, parity_group, parity_sha256, None))
            db.execute("DELETE FROM leaf WHERE artifact=?", (artifact_id,))
            db.execute("DELETE FROM localization WHERE artifact=?", (artifact_id,))
            db.execute("DELETE FROM pass WHERE artifact=? AND completed_ns IS NULL", (artifact_id,))
            db.executemany("INSERT INTO leaf(artifact, leaf, status) VALUES(?,?,?)",
                           ((artifact_id, index, UNVERIFIED) for index in range(leaf_count)))
            self.event("registered", artifact_id, tier=tier, leaf_count=leaf_count, root=root)

    def artifact(self, artifact_id):
        row = self.db.execute("SELECT * FROM artifact WHERE id=?", (artifact_id,)).fetchone()
        if row is None:
            return None
        names = [column[0] for column in self.db.execute("SELECT * FROM artifact LIMIT 0").description]
        return dict(zip(names, row))

    def artifacts(self, tier=None):
        names = [column[0] for column in self.db.execute("SELECT * FROM artifact LIMIT 0").description]
        sql, args = "SELECT * FROM artifact", ()
        if tier is not None:
            sql, args = sql + " WHERE tier=?", (tier,)
        return [dict(zip(names, row)) for row in self.db.execute(sql + " ORDER BY id", args)]

    def set_artifact_status(self, artifact_id, status, detail=None):
        with self.transaction() as db:
            prior = db.execute("SELECT status FROM artifact WHERE id=?", (artifact_id,)).fetchone()
            db.execute("UPDATE artifact SET status=?, detail=? WHERE id=?",
                       (status, json.dumps(detail) if detail is not None else None, artifact_id))
            if prior is None or prior[0] != status:
                self.event("artifact_" + status, artifact_id, **(detail or {}))

    # -- leaves -------------------------------------------------------------------

    def leaf(self, artifact_id, index):
        row = self.db.execute("SELECT status, last_verified_ns, fail_count, epoch FROM leaf WHERE artifact=? AND leaf=?",
                              (artifact_id, index)).fetchone()
        if row is None:
            return None
        return {"status": row[0], "last_verified_ns": row[1], "fail_count": row[2], "epoch": row[3]}

    def leaves_in(self, artifact_id, statuses):
        marks = ",".join("?" * len(statuses))
        return [row[0] for row in self.db.execute(
            f"SELECT leaf FROM leaf WHERE artifact=? AND status IN ({marks}) ORDER BY leaf", (artifact_id, *statuses))]

    def set_leaf(self, artifact_id, index, status, *, verified=False, failed=False, epoch=None, **detail):
        if status not in LEAF_STATES:
            raise ValueError(f"Unknown leaf state {status!r}")
        with self.transaction() as db:
            prior = db.execute("SELECT status FROM leaf WHERE artifact=? AND leaf=?", (artifact_id, index)).fetchone()
            if prior is None:
                raise KeyError(f"Leaf {index} of {artifact_id} is not registered")
            sets, args = ["status=?"], [status]
            if verified:
                sets.append("last_verified_ns=?")
                args.append(now_ns())
            if failed:
                sets.append("fail_count=fail_count+1")
            if epoch is not None:
                sets.append("epoch=?")
                args.append(epoch)
            db.execute(f"UPDATE leaf SET {', '.join(sets)} WHERE artifact=? AND leaf=?", (*args, artifact_id, index))
            if prior[0] != status or detail:
                self.event(status, artifact_id, index, prior=prior[0], **detail)

    def verified(self, artifact_id, index):
        """A leaf read back matching the manifest; the timestamp is what makes it count."""
        self.verified_many(artifact_id, [index])

    def verified_many(self, artifact_id, indexes):
        """Mark leaves read matching as `ok`, unless another writer has quarantined one since.

        A leaf the service flagged `suspect` after the read keeps that state: releasing it
        takes a fresh read and a reload, which the scrub's next confirmation provides.
        """
        marks = ",".join("?" * len(PLAIN))
        with self.transaction() as db:
            db.executemany(f"UPDATE leaf SET status=?, last_verified_ns=? WHERE artifact=? AND leaf=? "
                           f"AND status IN ({marks})",
                           ((OK, now_ns(), artifact_id, index, *PLAIN) for index in indexes))

    def localize(self, artifact_id, index, damage_class, detail):
        with self.transaction() as db:
            db.execute("INSERT OR REPLACE INTO localization VALUES(?,?,?,?)",
                       (artifact_id, index, damage_class, json.dumps(detail, sort_keys=True)))

    def localization(self, artifact_id, index):
        row = self.db.execute("SELECT class, detail FROM localization WHERE artifact=? AND leaf=?",
                              (artifact_id, index)).fetchone()
        return None if row is None else {"class": row[0], **json.loads(row[1])}

    # -- passes -------------------------------------------------------------------

    def pass_order(self, artifact_id):
        """Where an artifact stands in the rolling pass: a pass in progress first, then never passed, then oldest."""
        open_pass = self.db.execute("SELECT 1 FROM pass WHERE artifact=? AND completed_ns IS NULL LIMIT 1",
                                    (artifact_id,)).fetchone()
        last = self.last_full_pass(artifact_id)
        return (0, 0) if open_pass else (1, 0) if last is None else (2, last)

    def open_pass(self, artifact_id):
        """The artifact's pass in progress, resuming its cursor, or a new one at leaf zero."""
        row = self.db.execute("SELECT rowid, cursor FROM pass WHERE artifact=? AND completed_ns IS NULL "
                              "ORDER BY rowid DESC LIMIT 1", (artifact_id,)).fetchone()
        if row is not None:
            return row[0], row[1]
        with self.transaction() as db:
            cursor = db.execute("INSERT INTO pass VALUES(?,?,?,NULL)", (artifact_id, 0, now_ns()))
            return cursor.lastrowid, 0

    def advance(self, pass_id, cursor):
        self.db.execute("UPDATE pass SET cursor=? WHERE rowid=?", (cursor, pass_id))

    def complete_pass(self, pass_id):
        self.db.execute("UPDATE pass SET completed_ns=? WHERE rowid=?", (now_ns(), pass_id))

    def last_full_pass(self, artifact_id):
        row = self.db.execute("SELECT max(completed_ns) FROM pass WHERE artifact=?", (artifact_id,)).fetchone()
        return row[0]

    # -- retries ------------------------------------------------------------------

    def retry_due(self, artifact_id, index) -> bool:
        """Whether an unrepairable leaf's retry delay has passed since its last failed attempt."""
        row = self.leaf(artifact_id, index)
        since = (row or {}).get("last_verified_ns") or 0
        attempts, last = self.db.execute(
            "SELECT count(*), max(ts) FROM event WHERE artifact=? AND leaf=? AND kind=? AND ts>?",
            (artifact_id, index, UNREPAIRABLE, since)).fetchone()
        if not attempts:
            return True
        delay = min(RETRY_FIRST_SECONDS * 2 ** min(attempts - 1, 32), RETRY_LONGEST_SECONDS)
        return now_ns() - last >= delay * 1_000_000_000

    # -- reader epochs ------------------------------------------------------------

    def epoch(self, artifact_id) -> int:
        row = self.db.execute("SELECT epoch FROM reader_epoch WHERE artifact=?", (artifact_id,)).fetchone()
        return row[0] if row else 0

    def bump_epoch(self, artifact_id) -> int:
        """Advance an artifact's epoch, so every reader opened before now reloads before serving it."""
        with self.transaction() as db:
            current = db.execute("SELECT epoch FROM reader_epoch WHERE artifact=?", (artifact_id,)).fetchone()
            value = (current[0] if current else 0) + 1
            db.execute("INSERT OR REPLACE INTO reader_epoch VALUES(?,?)", (artifact_id, value))
            return value

    def acknowledge(self, artifact_id, loaded_epoch):
        """A reader opened at `loaded_epoch` is serving; leaves mended up to it are healthy again."""
        with self.transaction() as db:
            rows = db.execute("SELECT leaf FROM leaf WHERE artifact=? AND status=? AND epoch<=?",
                              (artifact_id, PENDING_RELOAD, loaded_epoch)).fetchall()
            for (index,) in rows:
                db.execute("UPDATE leaf SET status=? WHERE artifact=? AND leaf=?", (OK, artifact_id, index))
                self.event("reload_acknowledged", artifact_id, index, epoch=loaded_epoch)

    # -- sources and generations --------------------------------------------------

    def record_probe(self, artifact_id, source, ok, **detail):
        self.db.execute("INSERT OR REPLACE INTO source_probe VALUES(?,?,?,?,?)",
                        (artifact_id, source, int(bool(ok)), now_ns(), json.dumps(detail, sort_keys=True)))

    def record_generation_check(self, generation, kind, ok, **detail):
        self.db.execute("INSERT OR REPLACE INTO generation_check VALUES(?,?,?,?,?)",
                        (generation, kind, int(bool(ok)), now_ns(), json.dumps(detail, sort_keys=True)))
