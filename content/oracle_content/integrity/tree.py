"""Leaf hashing and the RFC 6962 Merkle tree the integrity manifest commits to.

Every artifact is split into fixed leaves; leaf *i* covers bytes
`[i * leaf_bytes, min((i + 1) * leaf_bytes, size))`, so only the last leaf is short.
Hashes are domain separated so that no preimage of one kind is a valid preimage of
another: a leaf is `SHA-256(0x00 || bytes)`, an interior node `SHA-256(0x01 || left ||
right)`, and an artifact record in the corpus tree `SHA-256(0x02 || sha256 || u64be(size)
|| u32be(leaf_bytes) || root)`. Without the prefixes a 64-byte interior preimage is also
a valid leaf, which admits a second-preimage attack on the tree (RFC 6962 section 2.1).

The tree shape is RFC 6962 section 2.1: for n > 1 hashes the left subtree takes the
largest power of two strictly less than n and the right subtree the remainder, with no
padding and no duplication of an odd node. The root of zero hashes is SHA-256 of the
empty string, as the RFC defines it.
"""
from __future__ import annotations

import hashlib
import struct

HASH_BYTES = 32
LEAF_PREFIX = b"\x00"
NODE_PREFIX = b"\x01"
RECORD_PREFIX = b"\x02"
LEAF_BYTES = 4 * 1024 * 1024
# Direct I/O moves whole logical blocks; 4096 is the largest block size in use on
# the storage this reads, so a leaf size that is a multiple of it reads aligned.
ALIGNMENT = 4096


def leaf_hash(data: bytes) -> bytes:
    return hashlib.sha256(LEAF_PREFIX + data).digest()


def node_hash(left: bytes, right: bytes) -> bytes:
    return hashlib.sha256(NODE_PREFIX + left + right).digest()


def record_hash(artifact_sha256: str, size: int, leaf_bytes: int, root: str) -> bytes:
    """The corpus tree's leaf for one artifact, binding its identity, size, leaf size and root."""
    return hashlib.sha256(RECORD_PREFIX + bytes.fromhex(artifact_sha256) + struct.pack(">QI", size, leaf_bytes)
                          + bytes.fromhex(root)).digest()


def split_point(n: int) -> int:
    """The largest power of two strictly less than n, for n > 1."""
    return 1 << ((n - 1).bit_length() - 1)


def root(hashes) -> bytes:
    """RFC 6962 Merkle tree hash over already-hashed leaves.

    Recursive over the tree's own shape, so a list of 60,000 leaves recurses about 16
    levels, not 60,000: each call halves at the RFC split point, which bounds the depth
    at log2(n).
    """
    hashes = list(hashes)
    if not hashes:
        return hashlib.sha256(b"").digest()

    def mth(start: int, stop: int) -> bytes:
        count = stop - start
        if count == 1:
            return hashes[start]
        middle = start + split_point(count)
        return node_hash(mth(start, middle), mth(middle, stop))

    return mth(0, len(hashes))


def leaf_count(size: int, leaf_bytes: int) -> int:
    return (size + leaf_bytes - 1) // leaf_bytes


def leaf_span(index: int, size: int, leaf_bytes: int) -> tuple[int, int]:
    start = index * leaf_bytes
    if index < 0 or start >= size:
        raise ValueError(f"Leaf {index} lies outside an artifact of {size} bytes")
    return start, min(start + leaf_bytes, size)


def split_leaves(raw: bytes) -> list[bytes]:
    """A `.leaves` file: the raw concatenation of 32-byte leaf hashes, nothing else."""
    if len(raw) % HASH_BYTES:
        raise ValueError("A leaf list is not a whole number of 32-byte hashes")
    return [raw[offset:offset + HASH_BYTES] for offset in range(0, len(raw), HASH_BYTES)]


def check_leaf_bytes(leaf_bytes: int) -> int:
    if type(leaf_bytes) is not int or leaf_bytes <= 0 or leaf_bytes % ALIGNMENT:
        raise ValueError(f"Leaf size must be a positive multiple of {ALIGNMENT} bytes for direct reads")
    return leaf_bytes
