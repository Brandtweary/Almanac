"""Interleaved XOR parity: the one source of replacement bytes that needs no network.

For N leaves and a group size k the stride is S = ceil(N / k), and group g holds leaves
{g, g + S, g + 2S, ...}. Its parity leaf is the XOR of its members, each zero padded to
the leaf size. Any one damaged member of a group is the XOR of the parity leaf and the
group's other members, trimmed to its own length.

Groups are interleaved rather than contiguous because storage damage arrives in bursts:
any contiguous run of up to S damaged leaves falls into S different groups, so all of
it is repairable. Parity is computed once, at admission, from bytes proven good in the
same pass. Artifacts never change and mending restores original bytes, so parity never
needs recomputing. A reconstruction is only a candidate: it is accepted, like bytes
from any other source, only if it hashes to the manifest's leaf.
"""
from __future__ import annotations

import os
import uuid
from pathlib import Path

from .tree import HASH_BYTES, leaf_hash, split_leaves

DEFAULT_GROUP = 128


def stride(leaf_total: int, group: int) -> int:
    if group < 2:
        raise ValueError("A parity group needs at least two members")
    return -(-leaf_total // group)


def members(index: int, leaf_total: int, group: int) -> list[int]:
    """Every leaf in the group of leaf `index`, in ascending order."""
    step = stride(leaf_total, group)
    return list(range(index % step, leaf_total, step))


class Accumulator:
    """Parity built in one sequential pass: each leaf is folded into its group as it is read."""

    def __init__(self, leaf_total: int, leaf_bytes: int, group: int):
        self.leaf_bytes, self.group = leaf_bytes, group
        self.stride = stride(leaf_total, group)
        self.groups = [0] * self.stride

    def add(self, index: int, data: bytes) -> None:
        self.groups[index % self.stride] ^= int.from_bytes(data.ljust(self.leaf_bytes, b"\0"), "little")

    def leaves(self) -> list[bytes]:
        return [value.to_bytes(self.leaf_bytes, "little") for value in self.groups]


def write(path: Path, parity_leaves: list[bytes]) -> bytes:
    """Store parity leaves and their hash list. Returns the hash list the state binds."""
    path.parent.mkdir(parents=True, exist_ok=True)
    hashes = b"".join(leaf_hash(leaf) for leaf in parity_leaves)
    for target, payload in ((path, b"".join(parity_leaves)), (hashes_path(path), hashes)):
        temporary = target.with_name(target.name + "." + uuid.uuid4().hex + ".tmp")
        try:
            with temporary.open("wb") as stream:
                stream.write(payload)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary, target)
        finally:
            temporary.unlink(missing_ok=True)
    return hashes


def hashes_path(path: Path) -> Path:
    return path.with_name(path.name + ".leaves")


def load_hashes(path: Path, expected_sha256: str | None) -> list[bytes]:
    import hashlib
    raw = hashes_path(path).read_bytes()
    if expected_sha256 is not None and hashlib.sha256(raw).hexdigest() != expected_sha256:
        raise ValueError("Parity hash list does not match the digest recorded at admission")
    if len(raw) % HASH_BYTES:
        raise ValueError("Parity hash list is not a whole number of hashes")
    return split_leaves(raw)


def reconstruct(index: int, *, leaf_total: int, size: int, leaf_bytes: int, group: int, read_member, read_parity,
                leaves: list[bytes], parity_hashes: list[bytes]) -> bytes:
    """Rebuild leaf `index` from its group, or raise if any other member or the parity is bad.

    Every member used and the parity leaf are checked against their own hashes first,
    so a second damaged member makes the reconstruction fail cleanly instead of
    producing plausible wrong bytes; the caller then falls through to other sources.
    """
    step = stride(leaf_total, group)
    slot = index % step
    parity = read_parity(slot)
    if len(parity) != leaf_bytes or leaf_hash(parity) != parity_hashes[slot]:
        raise ValueError(f"Parity leaf {slot} does not match its recorded hash")
    value = int.from_bytes(parity, "little")
    for member in members(index, leaf_total, group):
        if member == index:
            continue
        data = read_member(member)
        if leaf_hash(data) != leaves[member]:
            raise ValueError(f"Group member {member} is itself damaged")
        value ^= int.from_bytes(data.ljust(leaf_bytes, b"\0"), "little")
    length = min(leaf_bytes, size - index * leaf_bytes)
    return value.to_bytes(leaf_bytes, "little")[:length]


def recompute(slot: int, *, leaf_total: int, leaf_bytes: int, group: int, read_member, leaves: list[bytes]) -> bytes:
    """A parity leaf rebuilt from its group's data, every member verified first."""
    step = stride(leaf_total, group)
    value = 0
    for member in range(slot, leaf_total, step):
        data = read_member(member)
        if leaf_hash(data) != leaves[member]:
            raise ValueError(f"Group member {member} is damaged; its parity cannot be recomputed")
        value ^= int.from_bytes(data.ljust(leaf_bytes, b"\0"), "little")
    return value.to_bytes(leaf_bytes, "little")
