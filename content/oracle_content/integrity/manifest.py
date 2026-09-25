"""The committed integrity manifest: what every admitted artifact's bytes must be.

`corpus.json` lists one record per artifact and the corpus root over all of them;
`leaves/<sha256>.leaves` holds each artifact's leaf hashes. The manifest is the trust
root, so nothing acts on it before it has reproduced itself: every artifact root is
recomputed from its leaf file and compared with its record, and the corpus root is
recomputed from the records. A manifest that fails to reproduce is manifest damage,
reported as such and never mistaken for damage to the data it describes.

An entry is immutable once committed: the artifact is content addressed, so a new
edition is a new artifact with a new entry. Only an entry's `sources`, the list of
places replacement bytes may be fetched from, may change afterwards.
"""
from __future__ import annotations

import json
import os
import re
import uuid
from pathlib import Path

from .tree import HASH_BYTES, check_leaf_bytes, leaf_count, record_hash, root, split_leaves

SCHEMA = "almanac-integrity-v1"
HASH = "sha256"
TREE = "rfc6962-prefixed"
CORPUS = "corpus.json"
HEX64 = re.compile(r"[0-9a-f]{64}")
KINDS = {"upstream", "derived"}
MUTABLE_FIELDS = {"sources"}


class ManifestDamaged(Exception):
    """The manifest does not reproduce its own roots, so it cannot judge any bytes."""


def empty(leaf_bytes: int) -> dict:
    return {"schema": SCHEMA, "leaf_bytes": leaf_bytes, "hash": HASH, "tree": TREE, "artifacts": [],
            "corpus_root": corpus_root([], leaf_bytes)}


def corpus_root(records, leaf_bytes: int) -> str:
    ordered = sorted(records, key=lambda record: record["sha256"])
    return root(record_hash(record["sha256"], record["bytes"], leaf_bytes, record["root"]) for record in ordered).hex()


def validate(document: dict) -> dict:
    """Refuse a manifest whose shape this code does not understand, rather than guess at it."""
    if not isinstance(document, dict) or document.get("schema") != SCHEMA:
        raise ManifestDamaged("Integrity manifest schema is missing or unsupported")
    if document.get("hash") != HASH or document.get("tree") != TREE:
        raise ManifestDamaged("Integrity manifest names an unsupported hash or tree construction")
    try:
        check_leaf_bytes(document.get("leaf_bytes"))
    except ValueError as error:
        raise ManifestDamaged(str(error)) from None
    artifacts = document.get("artifacts")
    if not isinstance(artifacts, list) or not isinstance(document.get("corpus_root"), str):
        raise ManifestDamaged("Integrity manifest lacks its artifact list or corpus root")
    seen = set()
    for record in artifacts:
        if not isinstance(record, dict) or not HEX64.fullmatch(str(record.get("sha256"))) \
                or not HEX64.fullmatch(str(record.get("root"))) or type(record.get("bytes")) is not int \
                or record["bytes"] < 1 or record.get("kind") not in KINDS \
                or record.get("leaf_count") != leaf_count(record["bytes"], document["leaf_bytes"]) \
                or not isinstance(record.get("sources", []), list):
            raise ManifestDamaged(f"Integrity manifest record is malformed: {str(record)[:200]}")
        if record["sha256"] in seen:
            raise ManifestDamaged("Integrity manifest lists an artifact twice")
        seen.add(record["sha256"])
    return document


class Manifest:
    def __init__(self, directory: Path):
        self.directory = Path(directory)
        try:
            self.document = validate(json.loads((self.directory / CORPUS).read_text()))
        except (OSError, ValueError) as error:
            raise ManifestDamaged(f"Integrity manifest is unreadable: {error}") from None
        self.leaf_bytes = self.document["leaf_bytes"]
        self.by_sha = {record["sha256"]: record for record in self.document["artifacts"]}

    def records(self):
        return list(self.document["artifacts"])

    def record(self, sha256):
        return self.by_sha.get(sha256)

    def leaves_path(self, sha256) -> Path:
        return self.directory / "leaves" / (sha256 + ".leaves")

    def artifact_leaves(self, sha256) -> list[bytes]:
        """One artifact's leaf hashes, only once they reproduce its committed root."""
        record = self.by_sha.get(sha256)
        if record is None:
            raise ManifestDamaged(f"Artifact {sha256} is not in the integrity manifest")
        try:
            raw = self.leaves_path(sha256).read_bytes()
        except OSError as error:
            raise ManifestDamaged(f"Leaf list for {sha256} is unreadable: {error}") from None
        if len(raw) != HASH_BYTES * record["leaf_count"]:
            raise ManifestDamaged(f"Leaf list for {sha256} holds {len(raw) // HASH_BYTES} hashes, "
                                  f"not the {record['leaf_count']} its record states")
        leaves = split_leaves(raw)
        if root(leaves).hex() != record["root"]:
            raise ManifestDamaged(f"Leaf list for {sha256} does not reproduce its committed root")
        return leaves

    def check(self) -> dict:
        """Recompute every root. Returns the verdict for the corpus and for each artifact."""
        computed = corpus_root(self.document["artifacts"], self.leaf_bytes)
        verdicts = {}
        for sha256 in self.by_sha:
            try:
                self.artifact_leaves(sha256)
                verdicts[sha256] = None
            except ManifestDamaged as error:
                verdicts[sha256] = str(error)
        return {"corpus_ok": computed == self.document["corpus_root"], "corpus_root": self.document["corpus_root"],
                "computed_corpus_root": computed, "artifacts": verdicts}

    def trusted_leaves(self, sha256) -> list[bytes]:
        """Leaf hashes fit to decide a write: the corpus root and this artifact's root both reproduce."""
        if corpus_root(self.document["artifacts"], self.leaf_bytes) != self.document["corpus_root"]:
            raise ManifestDamaged("The corpus root does not reproduce from the manifest's records")
        return self.artifact_leaves(sha256)


def history_violations(snapshots) -> list[str]:
    """Every change to a committed entry across a sequence of manifest states, oldest first.

    Each snapshot is `(label, corpus_document, {sha256: leaf_bytes})`. An artifact's
    record fields other than `sources`, and its leaf file, must stay exactly as they were
    when it first appeared; an artifact may be retired, never rewritten.
    """
    first_record, first_leaves, violations = {}, {}, []
    for label, document, leaves in snapshots:
        for record in (document or {}).get("artifacts", []):
            sha = record.get("sha256")
            fixed = {key: value for key, value in record.items() if key not in MUTABLE_FIELDS}
            if sha not in first_record:
                first_record[sha] = fixed
            elif fixed != first_record[sha]:
                violations.append(f"{label}: record for {sha} changed")
        for sha, raw in leaves.items():
            if sha not in first_leaves:
                first_leaves[sha] = raw
            elif raw != first_leaves[sha]:
                violations.append(f"{label}: leaf list for {sha} changed")
    return violations


def _atomic_write(path: Path, payload: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + "." + uuid.uuid4().hex + ".tmp")
    try:
        with temporary.open("wb") as stream:
            stream.write(payload)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
        descriptor = os.open(path.parent, os.O_DIRECTORY)
        try:
            os.fsync(descriptor)
        finally:
            os.close(descriptor)
    finally:
        temporary.unlink(missing_ok=True)


def render(document: dict) -> bytes:
    return (json.dumps(document, indent=2, sort_keys=True, ensure_ascii=False) + "\n").encode()


def merge(target: Path, record: dict, leaves: bytes, *, leaf_bytes: int) -> dict:
    """Add one admitted artifact to a manifest directory, refusing to alter a committed entry.

    An entry already present must match in every field but `sources` and its leaf file
    must match byte for byte; anything else is a second admission disagreeing with the
    first, which is a fact to investigate and never something to overwrite. The corpus
    root is always re-derived, never carried over.
    """
    target = Path(target)
    path = target / CORPUS
    document = validate(json.loads(path.read_text())) if path.exists() else empty(leaf_bytes)
    if document["leaf_bytes"] != leaf_bytes:
        raise ValueError("The candidate was admitted at a different leaf size from this manifest")
    leaves_path = target / "leaves" / (record["sha256"] + ".leaves")
    existing = next((item for item in document["artifacts"] if item["sha256"] == record["sha256"]), None)
    if existing is not None:
        fixed = {key: value for key, value in record.items() if key not in MUTABLE_FIELDS}
        committed = {key: value for key, value in existing.items() if key not in MUTABLE_FIELDS}
        if fixed != committed:
            raise ValueError(f"Artifact {record['sha256']} is already committed with different fields")
        if not leaves_path.exists() or leaves_path.read_bytes() != leaves:
            raise ValueError(f"Artifact {record['sha256']} is already committed with a different leaf list")
        existing["sources"] = record.get("sources", [])
    else:
        if root(split_leaves(leaves)).hex() != record["root"]:
            raise ValueError("Candidate leaf list does not reproduce the candidate's root")
        _atomic_write(leaves_path, leaves)
        document["artifacts"].append(record)
    document["artifacts"].sort(key=lambda item: item["sha256"])
    document["corpus_root"] = corpus_root(document["artifacts"], leaf_bytes)
    validate(document)
    _atomic_write(path, render(document))
    return document
