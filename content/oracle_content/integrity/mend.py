"""Mending: writing back into an artifact bytes that verify against the manifest.

The transaction for leaf *i* of artifact A, each step a precondition of the next:

0. Take A's mend lock. There is at most one mender per artifact; the scrub never writes.
1. Trust the manifest first: the corpus root and A's root must both reproduce from the
   local files. A manifest that does not reproduce can never drive a write.
2. Confirm the damage now, with one more direct read. A write happens only after at
   least two independent reads have failed.
3. Obtain a candidate from the sources in order. It is accepted only at exactly the
   leaf's length and hashing to `leaves[i]`.
4. Journal the candidate, the record and the damaged pre-image, durably. Each journal
   file replaces its name atomically, so a crash leaves a file whole or absent.
5. Write the leaf in place and `fdatasync`.
6. Read the leaf back directly and verify it. A mismatch means the medium did not hold
   the write: the leaf is `write_failed`, escalated, and never retried in a loop.
7. Update the original's receipt with its new mtime; its size and SHA-256 are unchanged.
8. Advance A's reader epoch, so every reader opened before the write reloads before it
   serves A again, discarding any decoded damaged cluster it cached.
9. Remove the journal entry; keep the pre-image under bounded retention.

After a crash anywhere, recovery converges: a journaled leaf that now verifies finishes
steps 7 to 9; one that does not is rewritten from its journaled candidate if that still
verifies, and otherwise the entry is discarded and the leaf waits for a new mend. A
record that cannot be read is rebuilt from what decides recovery anyway: the leaf on
disk, the journaled candidate, the manifest, and the leaf's own state for whether the
medium already dropped a write. A leaf that was correct is never touched, because
step 2 gates every write and every write is confined to one leaf's bytes.

Every read a mend makes is held to the operator's rate, and a leaf no source could
repair is retried on a doubling delay rather than every cycle, since each attempt from
parity reads its whole group.
"""
from __future__ import annotations

import contextlib
import errno
import fcntl
import json
import os
import time
import uuid
from pathlib import Path

from . import medium as medium_steps
from . import parity as parity_files
from .admit import integrity_dir
from .manifest import Manifest, ManifestDamaged
from .medium import Medium, RateLimit, Throttled
from .sources import ParitySource, SourceFailure, accept, network_sources
from .state import (DAMAGED, MENDABLE, MENDING, OK, PENDING_RELOAD, QUARANTINED, SUSPECT, UNREPAIRABLE, WITHDRAWN,
                    WRITE_FAILED, State)
from .tree import leaf_hash, leaf_span

PREIMAGES_KEPT = 64


def _fsync_dir(path: Path) -> None:
    descriptor = os.open(path, os.O_DIRECTORY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def _durable(path: Path, payload: bytes) -> None:
    """Replace `path` with `payload`: a crash or a failed write leaves the old file or none, never part of the new."""
    temporary = path.with_name(f"{path.name}.{uuid.uuid4().hex}.tmp")
    try:
        descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_CLOEXEC, 0o644)
        try:
            view, written = memoryview(payload), 0
            while written < len(view):
                written += os.write(descriptor, view[written:])
            os.fsync(descriptor)
        finally:
            os.close(descriptor)
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)
    _fsync_dir(path.parent)


class Busy(Exception):
    """Another process holds this artifact's mend lock."""


@contextlib.contextmanager
def mend_lock(store_root: Path, artifact_id: str):
    """An artifact's mend lock, held for the block; `Busy` when another process holds it."""
    path = integrity_dir(store_root) / "journal" / (artifact_id + ".lock")
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "a") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise Busy(artifact_id) from None
        yield


class Mender:
    """Everything a mend of one Tier A artifact needs, held under its lock."""

    def __init__(self, store_root: Path, manifest_dir: Path, artifact_id: str, *, state: State, medium: Medium,
                 opener=None, write: bool = True, network: bool = True):
        self.store_root, self.manifest_dir = Path(store_root), Path(manifest_dir)
        self.id, self.state, self.medium, self.opener, self.write = artifact_id, state, medium, opener, write
        self.network = network
        self.row = state.artifact(artifact_id)
        self.path = self.store_root / self.row["path"]
        self.size, self.leaf_bytes = self.row["bytes"], self.row["leaf_bytes"]
        base = integrity_dir(store_root)
        self.journal = base / "journal" / artifact_id
        self.preimages = base / "preimages" / artifact_id
        self.held = base / "held" / artifact_id
        self.lock_path = base / "journal" / (artifact_id + ".lock")
        self.lock = None

    def __enter__(self):
        self.lock_path.parent.mkdir(parents=True, exist_ok=True)
        _fsync_dir(self.lock_path.parent.parent)
        self.lock = open(self.lock_path, "a")
        try:
            fcntl.flock(self.lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            self.lock.close()
            raise Busy(self.id) from None
        return self

    def __exit__(self, *exc):
        self.lock.close()

    # -- step 1 ---------------------------------------------------------------------

    def trusted_leaves(self):
        """The leaf hashes, only while the whole manifest reproduces its roots."""
        manifest = Manifest(self.manifest_dir)
        leaves = manifest.trusted_leaves(self.id)
        record = manifest.record(self.id)
        if record["bytes"] != self.size or manifest.leaf_bytes != self.leaf_bytes or record["root"] != self.row["root"]:
            raise ManifestDamaged("The committed record disagrees with this installation's registration")
        return manifest, record, leaves

    # -- step 3 ---------------------------------------------------------------------

    def sources(self, record, leaves):
        found = []
        if self.row["parity_path"]:
            parity_path = Path(self.row["parity_path"])

            def reconstruct(index):
                hashes = parity_files.load_hashes(parity_path, self.row["parity_sha256"])
                step = parity_files.stride(len(leaves), self.row["parity_group"])
                if len(hashes) != step:
                    raise ValueError("Parity hash list does not cover this artifact's groups")
                parity_size = step * self.leaf_bytes
                return parity_files.reconstruct(
                    index, leaf_total=len(leaves), size=self.size, leaf_bytes=self.leaf_bytes,
                    group=self.row["parity_group"], leaves=leaves, parity_hashes=hashes,
                    read_member=lambda member: self.medium.read_leaf_fresh(self.path, member, self.size, self.leaf_bytes),
                    read_parity=lambda slot: self.medium.read_leaf_fresh(parity_path, slot, parity_size, self.leaf_bytes))

            found.append(ParitySource(reconstruct))
        sha1_path = integrity_dir(self.store_root) / "upstream" / (self.id + ".sha1")
        upstream = None
        if sha1_path.exists():
            raw = sha1_path.read_bytes()
            upstream = [raw[offset:offset + 20] for offset in range(0, len(raw), 20)]
        if not self.network:
            return found
        return found + network_sources(record, leaf_bytes=self.leaf_bytes, opener=self.opener, upstream_sha1=upstream)

    def candidate(self, index, record, leaves):
        start, stop = leaf_span(index, self.size, self.leaf_bytes)
        for source in self.sources(record, leaves):
            try:
                payload = source.fetch(index)
            except SourceFailure as error:
                self.state.event("source_failed", self.id, index, source=source.name, error=str(error))
                continue
            crosscheck = source.crosscheck(index, payload) if isinstance(payload, bytes) else None
            if not accept(payload, leaves[index], stop - start):
                self.state.event("source_rejected", self.id, index, source=source.name,
                                 length=len(payload) if isinstance(payload, bytes) else None,
                                 upstream_piece_matched=crosscheck)
                continue
            if crosscheck is False:
                self.state.event("upstream_piece_disagrees", self.id, index, source=source.name)
            return source.name, payload
        return None, None

    # -- the transaction ------------------------------------------------------------

    def present(self) -> bool:
        """Only an original with its registered size may be repaired or receipted."""
        try:
            actual = self.path.stat().st_size
        except FileNotFoundError:
            self.state.set_artifact_status(self.id, "missing", {"path": str(self.path)})
            return False
        if actual != self.size:
            self.state.set_artifact_status(self.id, "size_mismatch", {"expected": self.size, "actual": actual})
            return False
        return True

    def mend(self, index) -> str:
        try:
            _manifest, record, leaves = self.trusted_leaves()
        except ManifestDamaged as error:
            self.state.event("manifest_damaged", self.id, index, error=str(error), action="no write")
            return "manifest_damaged"
        if not self.present():
            return self.state.artifact(self.id)["status"]
        current = self.medium.read_leaf_fresh(self.path, index, self.size, self.leaf_bytes)
        if leaf_hash(current) == leaves[index]:
            release(self.state, self.id, index, "verified_before_mend")
            return "not_damaged"
        if not self.write:
            start, stop = leaf_span(index, self.size, self.leaf_bytes)
            held = self.held / f"{index}.leaf"
            if held.exists() and accept(held.read_bytes(), leaves[index], stop - start):
                # Already held for a person, and still verifying: nothing to fetch again.
                return "held"
        self.state.set_leaf(self.id, index, MENDING)
        source, payload = self.candidate(index, record, leaves)
        medium_steps._step("candidate_chosen")
        if payload is None:
            self.state.set_leaf(self.id, index, UNREPAIRABLE, failed=True)
            return "unrepairable"
        if not self.write:
            # Artifact writes are switched off: keep what would have been written, for a
            # person to read, and leave the leaf damaged and quarantined.
            self.held.mkdir(parents=True, exist_ok=True)
            _durable(self.held / f"{index}.leaf", payload)
            self.state.set_leaf(self.id, index, DAMAGED, repair_held=source)
            return "held"
        self.journal.mkdir(parents=True, exist_ok=True)
        # Persist the artifact directory's name as well as its contents before
        # any original bytes change; recovery must survive a power loss too.
        _fsync_dir(self.journal.parent)
        entry = {"artifact": self.id, "leaf": index, "expected": leaves[index].hex(),
                 "damaged_hash": leaf_hash(current).hex(), "source": source,
                 "offset": index * self.leaf_bytes, "length": len(payload)}
        _durable(self.journal / f"{index}.leaf", payload)
        _durable(self.journal / f"{index}.pre", current)
        # The record is written last: recovery acts only on an entry whose record exists,
        # and by then the candidate it names is already durable.
        _durable(self.journal / f"{index}.json", json.dumps(entry, sort_keys=True).encode())
        _fsync_dir(self.journal)
        medium_steps._step("journal_written")
        return self.write_and_finish(index, payload, leaves)

    def write_and_finish(self, index, payload, leaves) -> str:
        offset = index * self.leaf_bytes
        try:
            self.medium.write_leaf(self.path, offset, payload)
        except OSError as error:
            if error.errno in (errno.EACCES, errno.EPERM, errno.EROFS):
                # Nothing reached the file, so the entry is discarded rather than retried.
                self.discard(index)
                self.state.set_leaf(self.id, index, DAMAGED, write_refused=f"{type(error).__name__}: {error}")
                return "write_refused"
            self.fail_write(index, f"{type(error).__name__}: {error}")
            return "write_failed"
        try:
            back = self.medium.read_leaf_fresh(self.path, index, self.size, self.leaf_bytes)
        except (OSError, EOFError) as error:
            self.fail_write(index, f"read back after fdatasync failed: {type(error).__name__}: {error}")
            return "write_failed"
        if leaf_hash(back) != leaves[index]:
            self.fail_write(index, "read back after fdatasync does not match the manifest")
            return "write_failed"
        medium_steps._step("before_receipt")
        self.finish(index)
        return "mended"

    def fail_write(self, index, reason):
        entry = self.read_record(index)
        entry["write_failed"] = reason
        _durable(self.journal / f"{index}.json", json.dumps(entry, sort_keys=True).encode())
        self.state.set_leaf(self.id, index, WRITE_FAILED, failed=True, reason=reason)

    def update_receipt(self):
        """Record the original's new mtime; its size and SHA-256 are what they always were."""
        receipt_path = self.path.with_suffix(".receipt.json")
        if receipt_path.exists():
            from ..store import atomic_json
            receipt = json.loads(receipt_path.read_text())
            stat = self.path.stat()
            atomic_json(receipt_path, {**receipt, "size": stat.st_size, "mtime_ns": stat.st_mtime_ns})

    def finish(self, index):
        """Steps 7 to 9, reached only once the leaf on disk verifies."""
        self.update_receipt()
        medium_steps._step("before_epoch")
        epoch = self.state.bump_epoch(self.id)
        self.state.set_leaf(self.id, index, PENDING_RELOAD, verified=True, epoch=epoch, mended=True)
        (self.held / f"{index}.leaf").unlink(missing_ok=True)
        pre = self.journal / f"{index}.pre"
        if pre.exists():
            self.preimages.mkdir(parents=True, exist_ok=True)
            os.replace(pre, self.preimages / f"{index}.{time.time_ns()}.pre")
            kept = sorted(self.preimages.glob("*.pre"), key=lambda path: path.stat().st_mtime_ns)
            for old in kept[:-PREIMAGES_KEPT]:
                old.unlink(missing_ok=True)
        self.discard(index)

    def discard(self, index):
        for suffix in (".json", ".leaf", ".pre"):
            (self.journal / f"{index}{suffix}").unlink(missing_ok=True)
        if self.journal.exists():
            _fsync_dir(self.journal)

    def read_record(self, index) -> dict:
        """A journal record, or one rebuilt from the leaf's state when the record cannot be read.

        Recovery takes nothing from a record that the leaf on disk, the journaled
        candidate and the manifest do not decide on their own, except whether the medium
        already dropped a write, and the leaf's state holds that too. The rebuilt record
        replaces the unreadable one, so the event is raised once, not every cycle.
        """
        path = self.journal / f"{index}.json"
        raw = path.read_bytes()
        try:
            entry = json.loads(raw)
            if isinstance(entry, dict) and entry.get("leaf") == index:
                return entry
            problem = "the record does not name this leaf"
        except ValueError as error:
            problem = f"{type(error).__name__}: {error}"
        current = self.state.leaf(self.id, index)
        entry = {"artifact": self.id, "leaf": index, "rebuilt": problem}
        if current is not None and current["status"] == WRITE_FAILED:
            entry["write_failed"] = "the leaf's state records a dropped write; the journal record was unreadable"
        self.state.event("journal_record_unreadable", self.id, index, error=problem, bytes=len(raw),
                         head=raw[:256].hex())
        _durable(path, json.dumps(entry, sort_keys=True).encode())
        return entry

    def recover(self) -> list:
        """Resolve every journal entry a crash left behind. Returns what happened to each."""
        outcomes = []
        if not self.present():
            return [("skipped", self.state.artifact(self.id)["status"])]
        records = ({path.stem for path in self.journal.glob("*.json") if path.stem.isdigit()}
                   if self.journal.exists() else set())
        for orphan in (self.journal.iterdir() if self.journal.exists() else ()):
            # Candidate or pre-image files without a record: the crash came before the
            # record was durable, so nothing was written to the artifact. A temporary is
            # a journal file whose write never completed.
            if orphan.suffix == ".tmp" or (orphan.suffix in (".leaf", ".pre") and orphan.stem not in records):
                orphan.unlink()
        for stem in sorted(records, key=int):
            index = int(stem)
            entry = self.read_record(index)
            if entry.get("write_failed"):
                outcomes.append((index, "write_failed_kept"))
                continue
            try:
                _manifest, _record, leaves = self.trusted_leaves()
            except ManifestDamaged as error:
                self.state.event("manifest_damaged", self.id, index, error=str(error), action="recovery halted")
                outcomes.append((index, "manifest_damaged"))
                continue
            on_disk = self.medium.read_leaf_fresh(self.path, index, self.size, self.leaf_bytes)
            if leaf_hash(on_disk) == leaves[index]:
                self.finish(index)
                self.state.event("recovered", self.id, index, outcome="finished")
                outcomes.append((index, "finished"))
                continue
            start, stop = leaf_span(index, self.size, self.leaf_bytes)
            candidate_path = self.journal / f"{stem}.leaf"
            candidate = candidate_path.read_bytes() if candidate_path.exists() else b""
            if not accept(candidate, leaves[index], stop - start):
                self.discard(index)
                self.state.set_leaf(self.id, index, DAMAGED, journal="discarded_candidate_failed_hash")
                outcomes.append((index, "discarded"))
                continue
            if not self.write:
                self.state.set_leaf(self.id, index, DAMAGED, journal="held_writes_disabled")
                outcomes.append((index, "held"))
                continue
            outcomes.append((index, self.write_and_finish(index, candidate, leaves)))
            self.state.event("recovered", self.id, index, outcome=outcomes[-1][1])
        # A mender that died before journalling left its leaf `mending` with nothing
        # written; under this lock no other mender owns it, so it is damaged again.
        journaled = {index for index, _outcome in outcomes}
        for index in self.state.leaves_in(self.id, (MENDING,)):
            if index not in journaled and not (self.journal / f"{index}.json").exists():
                self.state.set_leaf(self.id, index, DAMAGED, interrupted="before the journal")
                outcomes.append((index, "interrupted"))
        return outcomes


def release(state: State, artifact_id: str, index: int, reason: str) -> None:
    """A leaf reads back correct. One that was quarantined reloads its readers before it serves.

    A reader may hold a cluster decoded while the leaf was bad, so leaving quarantine
    advances the epoch; a leaf already awaiting reload keeps that label until a reader
    acknowledges, and any other leaf is simply verified.
    """
    current = state.leaf(artifact_id, index)
    status = current["status"] if current is not None else None
    if status == WRITE_FAILED:
        # A later readable copy does not complete a failed write transaction:
        # its receipt and journal still require operator reconciliation.
        state.set_leaf(artifact_id, index, WRITE_FAILED, verified=True)
    elif status in QUARANTINED:
        epoch = state.bump_epoch(artifact_id)
        state.set_leaf(artifact_id, index, PENDING_RELOAD, verified=True, epoch=epoch, reason=reason)
    elif status == PENDING_RELOAD:
        state.set_leaf(artifact_id, index, PENDING_RELOAD, verified=True)
    else:
        state.verified(artifact_id, index)


def mend_parity(store_root: Path, manifest_dir: Path, artifact_id: str, *, state: State, medium: Medium) -> list:
    """Recompute damaged parity leaves from their groups' verified data; an unrepairable one waits its retry delay."""
    parity_id = "parity-" + artifact_id
    row, parity_row = state.artifact(artifact_id), state.artifact(parity_id)
    outcomes = []
    if row is None or parity_row is None:
        return outcomes
    try:
        leaves = Manifest(manifest_dir).trusted_leaves(artifact_id)
    except ManifestDamaged as error:
        state.event("manifest_damaged", parity_id, error=str(error), action="no parity write")
        return outcomes
    path = Path(store_root) / row["path"]
    parity_path = Path(parity_row["path"])
    try:
        hashes = parity_files.load_hashes(parity_path, row["parity_sha256"])
    except (OSError, ValueError) as error:
        # Without its hash list no parity leaf can be judged, so none is written; the
        # data artifact's own mend then falls through to its other sources.
        state.event("parity_hashes_damaged", parity_id, error=f"{type(error).__name__}: {error}", action="no parity write")
        return [("parity_hashes_damaged", str(error))]
    for slot in state.leaves_in(parity_id, (DAMAGED, UNREPAIRABLE)):
        if not state.retry_due(parity_id, slot):
            outcomes.append((slot, "retry_deferred"))
            continue
        try:
            payload = parity_files.recompute(
                slot, leaf_total=len(leaves), leaf_bytes=row["leaf_bytes"], group=row["parity_group"], leaves=leaves,
                read_member=lambda member: medium.read_leaf_fresh(path, member, row["bytes"], row["leaf_bytes"]))
        except (ValueError, OSError, EOFError) as error:
            state.set_leaf(parity_id, slot, UNREPAIRABLE, failed=True, reason=str(error))
            outcomes.append((slot, "unrepairable"))
            continue
        if leaf_hash(payload) != hashes[slot]:
            state.set_leaf(parity_id, slot, UNREPAIRABLE, failed=True, reason="recomputed parity disagrees with its hash")
            outcomes.append((slot, "unrepairable"))
            continue
        try:
            medium.write_leaf(parity_path, slot * row["leaf_bytes"], payload)
            back = medium.read_leaf_fresh(parity_path, slot, parity_row["bytes"], row["leaf_bytes"])
        except (OSError, EOFError) as error:
            state.set_leaf(parity_id, slot, WRITE_FAILED, failed=True, reason=f"{type(error).__name__}: {error}")
            outcomes.append((slot, "write_failed"))
            continue
        if leaf_hash(back) != hashes[slot]:
            state.set_leaf(parity_id, slot, WRITE_FAILED, failed=True)
            outcomes.append((slot, "write_failed"))
            continue
        state.set_leaf(parity_id, slot, OK, verified=True, recomputed=True)
        outcomes.append((slot, "recomputed"))
    return outcomes


def withdraw_spans(store_root: Path, artifact_id: str, *, state: State) -> str:
    """Tier B is mended by withdrawal and rebuild: the damaged file is moved aside, never deleted."""
    row = state.artifact(artifact_id)
    path = Path(store_root) / row["path"]
    if not path.exists():
        state.set_artifact_status(artifact_id, WITHDRAWN, {"reason": "absent"})
        return "absent"
    aside = path.with_name(f"article-spans.damaged-{time.time_ns()}.sqlite")
    os.replace(path, aside)
    _fsync_dir(path.parent)
    state.set_artifact_status(artifact_id, WITHDRAWN, {"reason": "damaged", "moved_to": aside.name,
                                                       "rebuild": "tools/precompute_passages.py"})
    state.bump_epoch(artifact_id)
    return "withdrawn"


def mend_all(store_root: Path, manifest_dir: Path, *, medium: Medium | None = None, rate: RateLimit | None = None,
             opener=None, write: bool = True, network: bool = True, artifacts=None) -> dict:
    """Recover interrupted mends, then mend every damaged leaf the state records.

    Every direct read is held to `rate`. An unrepairable leaf whose retry delay has not
    passed is reported `retry_deferred` rather than attempted.
    """
    medium = Throttled(medium or Medium(), rate or RateLimit(None))
    state = State(integrity_dir(store_root))
    summary = {}
    try:
        # Parity first: a group whose parity is recomputed now can mend a data leaf below.
        order = {"P": 0, "A": 1, "B": 2}
        for row in sorted(state.artifacts(), key=lambda item: (order.get(item["tier"], 3), item["id"])):
            if artifacts is not None and row["id"] not in artifacts:
                continue
            if row["tier"] == "A" and row["status"] != "ok":
                # A resized or missing artifact is withdrawn and left to a person; nothing
                # is written into a file whose shape no longer matches its manifest.
                summary[row["id"]] = [("skipped", row["status"])]
            elif row["tier"] == "A":
                try:
                    with Mender(store_root, manifest_dir, row["id"], state=state, medium=medium, opener=opener,
                                write=write, network=network) as mender:
                        outcomes = [("recovery", mender.recover())]
                        for index in state.leaves_in(row["id"], MENDABLE):
                            if state.leaf(row["id"], index)["status"] == UNREPAIRABLE \
                                    and not state.retry_due(row["id"], index):
                                outcomes.append((index, "retry_deferred"))
                                continue
                            outcomes.append((index, mender.mend(index)))
                except Busy:
                    outcomes = [("busy", "another mender holds this artifact")]
                summary[row["id"]] = outcomes
            elif row["tier"] == "P" and write:
                try:
                    with mend_lock(store_root, row["id"]):
                        summary[row["id"]] = mend_parity(store_root, manifest_dir, row["id"][len("parity-"):],
                                                         state=state, medium=medium)
                except Busy:
                    summary[row["id"]] = [("busy", "another mender holds this parity file")]
            elif row["tier"] == "B" and write and row["status"] != WITHDRAWN \
                    and state.leaves_in(row["id"], (SUSPECT, DAMAGED, UNREPAIRABLE)):
                summary[row["id"]] = withdraw_spans(store_root, row["id"], state=state)
    finally:
        state.close()
    return summary
