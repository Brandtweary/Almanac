"""The rolling scrub: re-read every admitted leaf from the medium and compare it with the manifest.

Detection runs entirely offline. The scrub reads local files and the local copy of the
committed manifest and writes only verdicts into the integrity state; it never writes
into an artifact and makes no network call.

A mismatch on first read marks the leaf `suspect`, never `damaged`. It becomes
`damaged` only after a second independent direct read also mismatches; if the second
read matches the leaf is `transient`, and the event is kept, because repeated transients
on one region are a failing-media signal. Every pass also checks each artifact's size,
the manifest's own roots, the structure maps' and parity lists' digests, and each
generation manifest's identity.
"""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path

from ..models import digest
from . import parity as parity_files
from .admit import integrity_dir
from .manifest import Manifest, ManifestDamaged
from .medium import Medium, RateLimit
from .mend import release
from .state import (ARTIFACT_OK, DAMAGED, MENDING, MISSING, PENDING_RELOAD, QUARANTINED, SIZE_MISMATCH, SUSPECT,
                    TRANSIENT, UNREPAIRABLE, WITHDRAWN, WRITE_FAILED, State)
from .tree import leaf_hash, leaf_span, root, split_leaves
from . import zimmap

CURSOR_EVERY = 32


def self_check(state: State, manifest_dir: Path):
    """Check the manifest reproduces itself. Returns it, with the artifacts it can judge."""
    try:
        manifest = Manifest(manifest_dir)
    except ManifestDamaged as error:
        state.set_meta("manifest", {"ok": False, "error": str(error), "dir": str(Path(manifest_dir).resolve())})
        state.event("manifest_damaged", error=str(error))
        return None, set()
    verdict = manifest.check()
    trusted = set() if not verdict["corpus_ok"] else {sha for sha, error in verdict["artifacts"].items() if error is None}
    state.set_meta("manifest", {"ok": verdict["corpus_ok"] and all(error is None for error in verdict["artifacts"].values()),
                                "corpus_root": verdict["corpus_root"], "computed_corpus_root": verdict["computed_corpus_root"],
                                "artifacts": verdict["artifacts"], "dir": str(Path(manifest_dir).resolve())})
    if not verdict["corpus_ok"]:
        state.event("manifest_damaged", error="corpus root does not reproduce from the records")
    for sha, error in verdict["artifacts"].items():
        if error is not None:
            state.event("manifest_damaged", sha, error=error)
    return manifest, trusted


class Scrubber:
    def __init__(self, store_root: Path, *, state: State, medium: Medium, rate: RateLimit, budget: int | None = None):
        self.store_root, self.state, self.medium, self.rate = Path(store_root), state, medium, rate
        self.remaining = budget
        self.summary = {}

    def spend(self, count):
        self.rate.consume(count)
        if self.remaining is not None:
            self.remaining -= 1

    def exhausted(self):
        return self.remaining is not None and self.remaining <= 0

    def presence(self, artifact_id, path, size) -> bool:
        """Size is checked every pass; a missing or resized artifact is withdrawn whole and never mended in place."""
        row = self.state.artifact(artifact_id)
        try:
            actual = path.stat().st_size
        except FileNotFoundError:
            self.state.set_artifact_status(artifact_id, MISSING, {"path": str(path)})
            return False
        if actual != size:
            self.state.set_artifact_status(artifact_id, SIZE_MISMATCH, {"expected": size, "actual": actual})
            return False
        if row["status"] in (MISSING, SIZE_MISMATCH):
            self.state.set_artifact_status(artifact_id, ARTIFACT_OK, {"restored_from": row["status"]})
            self.state.bump_epoch(artifact_id)
        return True

    def confirm(self, artifact_id, path, index, size, leaf_bytes, expected, localize):
        """The second, independent read that alone may call a leaf damaged."""
        self.state.set_leaf(artifact_id, index, SUSPECT)
        second = self.medium.read_leaf_fresh(path, index, size, leaf_bytes)
        self.spend(len(second))
        if leaf_hash(second) == expected:
            self.state.set_leaf(artifact_id, index, TRANSIENT, second_read="matched")
            return TRANSIENT
        self.state.set_leaf(artifact_id, index, DAMAGED, failed=True, observed=leaf_hash(second).hex())
        if localize is not None:
            localize(index)
        return DAMAGED

    def artifact(self, artifact_id, path, leaves, *, localize=None):
        row = self.state.artifact(artifact_id)
        size, leaf_bytes = row["bytes"], row["leaf_bytes"]
        counts = self.summary.setdefault(artifact_id, {"read": 0, "damaged": 0, "transient": 0, "complete": False})
        if not self.presence(artifact_id, path, size):
            counts["status"] = self.state.artifact(artifact_id)["status"]
            return
        # Leaves the service flagged on its read path are confirmed first, out of cursor order.
        for index in self.state.leaves_in(artifact_id, (SUSPECT,)):
            first = self.medium.read_leaf_fresh(path, index, size, leaf_bytes)
            self.spend(len(first))
            counts["read"] += 1
            if leaf_hash(first) == leaves[index]:
                self.confirm_clean(artifact_id, index, path, size, leaf_bytes, leaves[index])
            else:
                counts[self.confirm(artifact_id, path, index, size, leaf_bytes, leaves[index], localize)] += 1
        pass_id, cursor = self.state.open_pass(artifact_id)
        descriptor = self.medium.open_direct(path)
        clean = []

        def checkpoint(position):
            # Matching leaves are marked once per batch rather than once per leaf, then
            # the cursor advances in its own write. A crash in between re-reads at most
            # one batch, and a leaf quarantined since its read keeps its quarantine.
            self.state.verified_many(artifact_id, clean)
            clean.clear()
            self.state.advance(pass_id, position)

        try:
            index = cursor
            while index < len(leaves):
                if self.exhausted():
                    break
                status = self.state.leaf(artifact_id, index)["status"]
                if status != MENDING:
                    data = self.medium.read_leaf(descriptor, index, size, leaf_bytes)
                    self.spend(len(data))
                    counts["read"] += 1
                    if leaf_hash(data) == leaves[index]:
                        if status in QUARANTINED or status == PENDING_RELOAD:
                            release(self.state, artifact_id, index, "verified_by_scrub")
                        else:
                            clean.append(index)
                    elif status in (DAMAGED, UNREPAIRABLE, WRITE_FAILED):
                        # Still bad, and already known to be. Relabelling it would re-arm a
                        # mend that has already failed; `write_failed` stays for a person.
                        counts["damaged"] += 1
                    else:
                        counts[self.confirm(artifact_id, path, index, size, leaf_bytes, leaves[index], localize)] += 1
                index += 1
                if index % CURSOR_EVERY == 0:
                    checkpoint(index)
            checkpoint(index)
            if index >= len(leaves):
                self.state.complete_pass(pass_id)
                counts["complete"] = True
        finally:
            os.close(descriptor)

    def confirm_clean(self, artifact_id, index, path, size, leaf_bytes, expected):
        # A read-path mismatch the medium does not reproduce was a fault above the disk,
        # most likely in cached memory. The leaf leaves quarantine through a reload, since
        # a reader may have decoded the bad copy, and the event is kept.
        release(self.state, artifact_id, index, "read_path_not_reproduced")


def localizer(state: State, store_root: Path, row: dict):
    """Name, from the structure map captured at admission, what a damaged leaf costs."""
    map_path = integrity_dir(store_root) / "structure" / (row["id"] + ".map")

    def localize(index):
        start, end = leaf_span(index, row["bytes"], row["leaf_bytes"])
        if not row["map_sha256"]:
            state.localize(row["id"], index, "unmapped", {"reason": "not a ZIM archive", "documents": None})
            return
        try:
            structure = zimmap.StructureMap(map_path, row["map_sha256"])
        except (OSError, zimmap.MapError, ValueError) as error:
            state.localize(row["id"], index, "structural", {"reason": f"structure map unavailable: {error}",
                                                            "documents": None})
            return
        try:
            verdict = structure.classify(start, end)
            entries = structure.entries_in(verdict["clusters"])
            documents = [entry for entry in entries if structure.entry_mime(entry) < zimmap.LINKTARGET]
            state.localize(row["id"], index, verdict["class"] or "unmapped",
                           {"clusters": verdict["clusters"], "structural_regions": verdict["structural_regions"],
                            "lexical": verdict["lexical"], "entries": entries, "documents": len(documents)})
        finally:
            structure.close()
    return localize


def check_generations(state: State, store_root: Path) -> dict:
    """Recompute each native generation's identity from its stored manifest.

    The directory name is the digest of the identity fields `build_native` wrote, so a
    manifest altered after publication, including the field naming which original the
    generation reads, no longer reproduces its own name. The check is reported, never
    acted on: the service keeps serving and the coverage labels the mismatch.

    `rights_exclusions` joined the identity after the first generations were written, and
    those manifests carry no such field, so it is part of the identity exactly when the
    manifest carries it. Removing it from a manifest written with it still changes the
    digest, so its absence cannot pass for an earlier generation.
    """
    from ..native import KIND
    results = {}
    for path in sorted((Path(store_root) / "generations").glob("*/manifest.json")):
        generation = path.parent.name
        try:
            manifest = json.loads(path.read_text())
        except (OSError, ValueError) as error:
            state.record_generation_check(generation, "identity", False, error=f"unreadable: {error}")
            results[generation] = False
            continue
        if manifest.get("kind") != KIND:
            continue
        try:
            identity = {"kind": manifest["kind"],
                        "source": {key: value for key, value in manifest["source"].items() if key != "original_path"},
                        "index_fingerprint": manifest["index_fingerprint"], "selection_policy": manifest["selection_policy"],
                        "representation": manifest["representation"], "vector_datatype": manifest["vector_datatype"]}
            if "rights_exclusions" in manifest:
                identity["rights_exclusions"] = manifest["rights_exclusions"]
            ok = digest(identity) == generation
        except (KeyError, TypeError, AttributeError) as error:
            state.record_generation_check(generation, "identity", False, error=f"identity fields absent: {error}")
            results[generation] = False
            continue
        state.record_generation_check(generation, "identity", ok)
        if not ok:
            state.event("generation_identity_mismatch", generation=generation)
        results[generation] = ok
    return results


def register_committed(state: State, store_root: Path, manifest: Manifest, trusted: set) -> None:
    """An installation that holds an original the committed manifest describes scrubs it too.

    Every clone carries the full leaf lists, so an installation that never ran admission
    itself can still verify its copy; it lacks only the locally derived map and parity.
    """
    for record in manifest.records():
        sha = record["sha256"]
        if sha not in trusted or state.artifact(sha) is not None:
            continue
        path = Path(store_root) / "originals" / sha
        if path.is_file():
            state.register(sha, tier="A", path=f"originals/{sha}", size=record["bytes"], leaf_bytes=manifest.leaf_bytes,
                           leaf_count=record["leaf_count"], root=record["root"], file_sha256=sha)


def scrub(store_root: Path, manifest_dir: Path, *, medium: Medium | None = None, rate: RateLimit | None = None,
          budget: int | None = None, artifacts=None) -> dict:
    """One slice of the rolling pass over every admitted artifact, resuming each cursor.

    `budget` bounds how many leaves this call reads, so a long pass can run as a
    series of bounded slices; without it the call finishes the pass. Artifacts are taken
    in pass order, a pass in progress first and then the one whose last full pass is
    oldest, so a series of slices reaches every artifact before revisiting any.
    """
    medium, rate = medium or Medium(), rate or RateLimit(None)
    state = State(integrity_dir(store_root))
    try:
        manifest, trusted = self_check(state, manifest_dir)
        if manifest is not None:
            register_committed(state, store_root, manifest, trusted)
        scrubber = Scrubber(store_root, state=state, medium=medium, rate=rate, budget=budget)
        for row in sorted(state.artifacts(), key=lambda item: (state.pass_order(item["id"]), item["id"])):
            if artifacts is not None and row["id"] not in artifacts:
                continue
            if scrubber.exhausted():
                break
            if row["tier"] == "A":
                if manifest is None or row["id"] not in trusted:
                    scrubber.summary[row["id"]] = {"skipped": "not judged: its manifest entry is absent or damaged"}
                    continue
                leaves = manifest.artifact_leaves(row["id"])
                if manifest.record(row["id"])["bytes"] != row["bytes"] or row["leaf_bytes"] != manifest.leaf_bytes:
                    state.event("registration_disagrees_with_manifest", row["id"])
                    scrubber.summary[row["id"]] = {"skipped": "registration disagrees with the committed record"}
                    continue
                scrubber.artifact(row["id"], Path(store_root) / row["path"], leaves,
                                  localize=localizer(state, store_root, row))
                check_map(state, store_root, row)
            elif row["tier"] == "B":
                if row["status"] == WITHDRAWN:
                    continue
                leaves = local_leaves(state, store_root, row)
                if leaves is not None:
                    scrubber.artifact(row["id"], Path(store_root) / row["path"], leaves)
            elif row["tier"] == "P":
                leaves = parity_leaves(state, row)
                if leaves is not None:
                    scrubber.artifact(row["id"], Path(row["path"]), leaves)
        check_generations(state, store_root)
        return scrubber.summary
    finally:
        state.close()


def local_leaves(state: State, store_root: Path, row: dict):
    path = integrity_dir(store_root) / "derived" / (row["id"] + ".leaves")
    try:
        leaves = split_leaves(path.read_bytes())
    except (OSError, ValueError) as error:
        state.event("local_leaves_damaged", row["id"], error=str(error))
        return None
    if len(leaves) != row["leaf_count"] or root(leaves).hex() != row["root"]:
        state.event("local_leaves_damaged", row["id"], error="does not reproduce the recorded root")
        return None
    return leaves


def parity_leaves(state: State, row: dict):
    owner = state.artifact(row["id"][len("parity-"):])
    try:
        leaves = parity_files.load_hashes(Path(row["path"]), owner["parity_sha256"] if owner else None)
    except (OSError, ValueError) as error:
        state.event("parity_hashes_damaged", row["id"], error=str(error))
        return None
    return leaves


def check_map(state: State, store_root: Path, row: dict) -> None:
    if not row["map_sha256"]:
        return
    path = integrity_dir(store_root) / "structure" / (row["id"] + ".map")
    try:
        with open(path, "rb") as stream:
            ok = hashlib.file_digest(stream, "sha256").hexdigest() == row["map_sha256"]
    except OSError:
        ok = False
    if not ok:
        state.event("structure_map_damaged", row["id"])
