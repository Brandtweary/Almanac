"""Admission: the one pass that creates an artifact's leaf list, and the anchor of all trust.

Admission is the only moment the design trusts bytes on disk, so it trusts them only
once they prove to be the pinned bytes. One sequential direct read computes, together,
the whole-file SHA-256, every leaf hash, the SHA-1 of every leaf where the upstream
publishes a piece table, and the parity accumulators. Nothing is written unless the
whole-file SHA-256 equals the artifact's pinned identity and, for a pin with a piece
table, every leaf matches its upstream piece. The structure map is then parsed from
leaves re-read and checked against the list the pass just produced, so it too comes
only from verified bytes.

What admission writes is a candidate: the leaf list and manifest record become the
trust root only once they are committed to the repository's integrity manifest.
"""
from __future__ import annotations

import hashlib
import json
import os
import subprocess
import uuid
import xml.etree.ElementTree as ET
from pathlib import Path

from . import parity as parity_files
from . import zimmap
from .manifest import merge
from .medium import Medium, RateLimit, Throttled
from .state import State
from .tree import check_leaf_bytes, leaf_count, leaf_hash, root

METALINK = {"m": "urn:ietf:params:xml:ns:metalink"}


class AdmissionRefused(Exception):
    def __init__(self, reason, **detail):
        super().__init__(reason)
        self.reason, self.detail = reason, detail


def integrity_dir(store_root: Path) -> Path:
    return Path(store_root) / "integrity"


def parse_metalink(raw: bytes, *, size: int, sha256: str) -> dict:
    """The upstream SHA-1 piece table, only from a metalink that describes exactly this artifact."""
    document = ET.fromstring(raw)
    file = document.find("m:file", METALINK)
    if file is None:
        raise AdmissionRefused("metalink_malformed")
    declared_size = file.find("m:size", METALINK)
    declared_sha = file.find("m:hash[@type='sha-256']", METALINK)
    if declared_size is None or int(declared_size.text) != size or declared_sha is None or declared_sha.text.strip() != sha256:
        raise AdmissionRefused("metalink_describes_another_artifact")
    pieces = file.find("m:pieces[@type='sha-1']", METALINK)
    if pieces is None:
        raise AdmissionRefused("metalink_has_no_piece_table")
    hashes = [node.text.strip() for node in pieces.findall("m:hash", METALINK)]
    if any(len(value) != 40 for value in hashes):
        raise AdmissionRefused("metalink_piece_table_malformed")
    return {"length": int(pieces.attrib["length"]), "pieces": [bytes.fromhex(value) for value in hashes],
            "metalink_sha256": hashlib.sha256(raw).hexdigest()}


def tool_version() -> str:
    """The commit the admission code came from, or a digest of its source where there is no checkout."""
    here = Path(__file__).resolve().parent
    try:
        commit = subprocess.run(["git", "-C", str(here), "rev-parse", "HEAD"], capture_output=True, text=True,
                                timeout=10, stdin=subprocess.DEVNULL)
        dirty = subprocess.run(["git", "-C", str(here), "status", "--porcelain", "--", str(here)],
                               capture_output=True, text=True, timeout=10, stdin=subprocess.DEVNULL)
        if commit.returncode == 0 and dirty.returncode == 0:
            return commit.stdout.strip() + ("-modified" if dirty.stdout.strip() else "")
    except (OSError, subprocess.SubprocessError):
        pass
    digest = hashlib.sha256()
    for path in sorted(here.glob("*.py")):
        digest.update(path.name.encode() + b"\0" + path.read_bytes())
    return "source-sha256:" + digest.hexdigest()


def read_pass(path: Path, *, leaf_bytes: int, medium: Medium, rate: RateLimit, upstream: dict | None,
              parity_group: int | None) -> dict:
    size = path.stat().st_size
    total = leaf_count(size, leaf_bytes)
    whole = hashlib.sha256()
    leaves, piece_mismatches = [], []
    accumulator = parity_files.Accumulator(total, leaf_bytes, parity_group) if parity_group and total else None
    descriptor = medium.open_direct(path)
    try:
        for index in range(total):
            data = medium.read_leaf(descriptor, index, size, leaf_bytes)
            whole.update(data)
            leaves.append(leaf_hash(data))
            if upstream is not None and hashlib.sha1(data).digest() != upstream["pieces"][index]:
                piece_mismatches.append(index)
            if accumulator is not None:
                accumulator.add(index, data)
            rate.consume(len(data))
    finally:
        os.close(descriptor)
    return {"size": size, "sha256": whole.hexdigest(), "leaves": leaves, "piece_mismatches": piece_mismatches,
            "parity": accumulator.leaves() if accumulator is not None else None}


def _stage(path: Path, payload: bytes) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + "." + uuid.uuid4().hex + ".staged")
    with temporary.open("wb") as stream:
        stream.write(payload)
        stream.flush()
        os.fsync(stream.fileno())
    return temporary


def admit(store_root: Path, sha256: str, *, kind: str, pack_path: str, sources: list, leaf_bytes: int,
          parity_dir: Path, parity_group: int = parity_files.DEFAULT_GROUP, upstream: dict | None = None,
          medium: Medium | None = None, rate: RateLimit | None = None, version: str | None = None) -> dict:
    """Admit one original under `store_root/originals/<sha256>`, or refuse and write nothing.

    Returns the candidate manifest record. Refusal raises `AdmissionRefused`, whose
    detail names the upstream pieces that failed when a piece table was supplied, so a
    damaged archive is localised even though it cannot be admitted.
    """
    medium, rate = medium or Medium(), rate or RateLimit(None)
    check_leaf_bytes(leaf_bytes)
    if kind not in {"upstream", "derived"}:
        raise ValueError("An artifact is either an upstream pin or derived")
    path = Path(store_root) / "originals" / sha256
    if not path.is_file():
        raise AdmissionRefused("artifact_missing", path=str(path))
    size = path.stat().st_size
    if upstream is not None:
        if upstream["length"] != leaf_bytes or len(upstream["pieces"]) != leaf_count(size, leaf_bytes):
            # A piece table at another granularity cannot cross-check these leaves, and
            # admitting without the cross-check it promises would overstate the record.
            raise AdmissionRefused("piece_table_granularity_differs", piece_length=upstream["length"],
                                   pieces=len(upstream["pieces"]))
    scan = read_pass(path, leaf_bytes=leaf_bytes, medium=medium, rate=rate, upstream=upstream,
                     parity_group=parity_group)
    if scan["sha256"] != sha256:
        raise AdmissionRefused("whole_file_sha256_mismatch", computed=scan["sha256"],
                               mismatched_pieces=scan["piece_mismatches"] if upstream is not None else None)
    if scan["piece_mismatches"]:
        raise AdmissionRefused("upstream_piece_mismatch", mismatched_pieces=scan["piece_mismatches"])
    leaves = scan["leaves"]
    reader = zimmap.VerifiedReader(Throttled(medium, rate), path, size, leaf_bytes, leaves)
    try:
        structure = zimmap.build(reader)
    except zimmap.LeafMismatch as error:
        raise AdmissionRefused("bytes_changed_during_admission", detail=str(error)) from None
    finally:
        reader.close()
    artifact_root = root(leaves).hex()
    record = {"sha256": sha256, "bytes": size, "leaf_count": len(leaves), "root": artifact_root,
              "pack_path": pack_path, "kind": kind,
              "admission": {"whole_file_sha256_verified": True,
                            "upstream_pieces": None if upstream is None else {
                                "type": "sha-1", "length": upstream["length"], "count": len(upstream["pieces"]),
                                "matched": len(upstream["pieces"]), "metalink_sha256": upstream["metalink_sha256"]},
                            "tool_version": version or tool_version()},
              "sources": sources}

    # Every output is staged first and moved into place only once all of them exist, and
    # the artifact is registered only after the last move. An interruption before the
    # moves leaves staged files behind; one during them can leave some outputs replaced,
    # but nothing is registered, so nothing trusts them, and a re-run overwrites them.
    base = integrity_dir(store_root)
    outputs = [(base / "candidates" / (sha256 + ".leaves"), b"".join(leaves)),
               (base / "candidates" / (sha256 + ".json"), json.dumps(record, indent=2, sort_keys=True).encode())]
    map_sha = None
    if structure is not None:
        outputs.append((base / "structure" / (sha256 + ".map"), structure))
        map_sha = hashlib.sha256(structure).hexdigest()
    if upstream is not None:
        outputs.append((base / "upstream" / (sha256 + ".sha1"), b"".join(upstream["pieces"])))
    parity_path, parity_sha = None, None
    if scan["parity"] is not None:
        parity_path = Path(parity_dir) / (sha256 + ".parity")
        hashes = b"".join(leaf_hash(leaf) for leaf in scan["parity"])
        outputs += [(parity_path, b"".join(scan["parity"])), (parity_files.hashes_path(parity_path), hashes)]
        parity_sha = hashlib.sha256(hashes).hexdigest()
    staged = []
    try:
        staged = [(_stage(target, payload), target) for target, payload in outputs]
        for temporary, target in staged:
            os.replace(temporary, target)
    finally:
        for temporary, _target in staged:
            temporary.unlink(missing_ok=True)
    state = State(base)
    try:
        state.register(sha256, tier="A", path=f"originals/{sha256}", size=size, leaf_bytes=leaf_bytes,
                       leaf_count=len(leaves), root=artifact_root, file_sha256=sha256, map_sha256=map_sha,
                       parity_path=str(parity_path) if parity_path else None, parity_group=parity_group,
                       parity_sha256=parity_sha)
        if parity_path is not None:
            # Parity is scrubbed like everything else, under its own record, so a damaged
            # parity leaf is found and recomputed before a mend ever needs it.
            parity_hashes = [leaf_hash(leaf) for leaf in scan["parity"]]
            state.register("parity-" + sha256, tier="P", path=str(parity_path), size=len(scan["parity"]) * leaf_bytes,
                           leaf_bytes=leaf_bytes, leaf_count=len(parity_hashes), root=root(parity_hashes).hex())
        state.event("admitted", sha256, root=artifact_root, map=map_sha is not None,
                    upstream_pieces=None if upstream is None else len(upstream["pieces"]))
    finally:
        state.close()
    return record


def publish_candidate(store_root: Path, sha256: str, manifest_dir: Path, *, sources: list | None = None) -> dict:
    """Merge one admitted candidate into a manifest directory, re-deriving the corpus root.

    `sources`, when given, replaces the candidate's: an entry's sources are the one part
    of it that may change after it is committed.
    """
    base = integrity_dir(store_root) / "candidates"
    record = json.loads((base / (sha256 + ".json")).read_text())
    if sources is not None:
        record["sources"] = sources
    leaves = (base / (sha256 + ".leaves")).read_bytes()
    current = Path(manifest_dir) / "corpus.json"
    leaf_bytes = json.loads(current.read_text())["leaf_bytes"] if current.exists() else None
    if leaf_bytes is None:
        raise ValueError("The target manifest directory has no corpus.json to merge into")
    return merge(manifest_dir, record, leaves, leaf_bytes=leaf_bytes)


def admit_derived(store_root: Path, generation: str, *, leaf_bytes: int, rate: RateLimit,
                  medium: Medium | None = None) -> dict:
    """Record a published spans artifact's leaves, local only, for scrubbing.

    A spans artifact is rebuildable from its original and machine specific, since its
    page layout depends on write order, so its leaves are never committed. The list is
    taken right after the artifact is published complete and immutable. The rate is
    required: this read runs unattended beside the serving index, so an unthrottled read
    has to be asked for by name with `RateLimit(None)`.
    """
    medium = medium or Medium()
    relative = f"generations/{generation}/article-spans.sqlite"
    path = Path(store_root) / relative
    scan = read_pass(path, leaf_bytes=leaf_bytes, medium=medium, rate=rate, upstream=None, parity_group=None)
    artifact_id = "spans-" + generation
    base = integrity_dir(store_root)
    target = base / "derived" / (artifact_id + ".leaves")
    temporary = _stage(target, b"".join(scan["leaves"]))
    os.replace(temporary, target)
    artifact_root = root(scan["leaves"]).hex()
    state = State(base)
    try:
        state.register(artifact_id, tier="B", path=relative, size=scan["size"], leaf_bytes=leaf_bytes,
                       leaf_count=len(scan["leaves"]), root=artifact_root, generation=generation,
                       file_sha256=scan["sha256"])
        state.bump_epoch(artifact_id)
    finally:
        state.close()
    return {"artifact": artifact_id, "root": artifact_root, "leaf_count": len(scan["leaves"]), "sha256": scan["sha256"],
            "read_rate": rate.rate}
