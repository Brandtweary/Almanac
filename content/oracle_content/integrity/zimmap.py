"""The structure map: which byte ranges of a ZIM archive hold which of its documents.

A damaged leaf is only useful to report once it is named in documents, and only
tolerable to serve around once the service knows which documents it touches. The map
answers both. It is built once, at admission, from bytes that verify against the leaf
list admission has just produced, and it is never re-derived from the live archive
afterwards: the tables it is read from are exactly what damage can corrupt.

It records the archive's structural regions (header, MIME list, pointer lists, the
directory-entry region), each cluster's byte extent, and for every entry the cluster
holding its content and its MIME type. The ZIM format is documented at
https://wiki.openzim.org/wiki/ZIM_file_format .

Damage classes, most severe first:
- structural: a region the reader navigates by, or a cluster holding the archive's
  metadata. The archive cannot be trusted to navigate, so all of it is withdrawn.
- index: a cluster holding a search index entry. Lexical search over the archive is
  withdrawn; reads and dense search continue.
- document: any other cluster. Only the entries stored in it are refused.
- trailer: the archive's own trailing MD5, which serving never reads.
"""
from __future__ import annotations

import array
import hashlib
import json
import mmap
import os
import struct
import sys
import uuid
from bisect import bisect_right
from pathlib import Path

from .tree import leaf_hash

MAGIC = 72173914
HEADER = struct.Struct("<IHH16sIIQQQQIIQ")
DIRENT_FIXED = struct.Struct("<HBcI")
MAP_MAGIC = b"ALMANAC-ZIMMAP1\n"
NO_CLUSTER = 0xFFFFFFFF
REDIRECT = 0xFFFF
LINKTARGET, DELETED = 0xFFFE, 0xFFFD
ABSENT = 0xFFFFFFFFFFFFFFFF
INDEX_NAMESPACES = {"X", "Z"}
METADATA_NAMESPACES = {"M"}
MIME_LIST_LIMIT = 1024 * 1024
DIRENT_LIMIT = 64 * 1024
WINDOW = 4 * 1024 * 1024
STRUCTURAL, INDEX, DOCUMENT, TRAILER = "structural", "index", "document", "trailer"


class LeafMismatch(Exception):
    """Bytes read to build or use a map no longer match the leaf list they must match."""


class MapError(Exception):
    """A map cannot be built from these bytes, or a stored map does not verify."""


class VerifiedReader:
    """Byte ranges of an artifact, served only from leaves that match their hashes.

    Every leaf is read directly from the medium and compared with the leaf list before
    any of its bytes are returned, so a structure parsed through this reader is parsed
    from verified bytes whatever happens to the file between reads.
    """

    def __init__(self, medium, path, size, leaf_bytes, leaves, keep=4):
        self.medium, self.size, self.leaf_bytes, self.leaves, self.keep = medium, size, leaf_bytes, leaves, keep
        self.descriptor = medium.open_direct(path)
        self.cache = {}

    def close(self):
        os.close(self.descriptor)

    def leaf(self, index):
        cached = self.cache.get(index)
        if cached is not None:
            return cached
        data = self.medium.read_leaf(self.descriptor, index, self.size, self.leaf_bytes)
        if leaf_hash(data) != self.leaves[index]:
            raise LeafMismatch(f"Leaf {index} no longer matches the admitted leaf list")
        if len(self.cache) >= self.keep:
            self.cache.pop(next(iter(self.cache)))
        self.cache[index] = data
        return data

    def read(self, start, length):
        if start < 0 or length < 0 or start + length > self.size:
            raise MapError(f"Range {start}+{length} lies outside the {self.size}-byte artifact")
        parts, position, stop = [], start, start + length
        while position < stop:
            index = position // self.leaf_bytes
            data = self.leaf(index)
            offset = position - index * self.leaf_bytes
            piece = data[offset:offset + (stop - position)]
            parts.append(piece)
            position += len(piece)
        return b"".join(parts)


def _native(values: array.array) -> bytes:
    if sys.byteorder != "little":
        values = array.array(values.typecode, values)
        values.byteswap()
    return values.tobytes()


def _from_little(typecode, raw) -> array.array:
    values = array.array(typecode)
    values.frombytes(raw)
    if sys.byteorder != "little":
        values.byteswap()
    return values


def build(reader: VerifiedReader) -> bytes | None:
    """Parse a ZIM archive's tables into a map, or None when the artifact is not a ZIM."""
    size = reader.size
    if size < HEADER.size:
        return None
    (magic, major, minor, _uuid, entry_count, cluster_count, path_pointers, title_pointers,
     cluster_pointers, mime_list, _main, _layout, checksum) = HEADER.unpack(reader.read(0, HEADER.size))
    if magic != MAGIC:
        return None
    for name, position, width in (("path pointer list", path_pointers, 8 * entry_count),
                                  ("cluster pointer list", cluster_pointers, 8 * cluster_count),
                                  ("MIME list", mime_list, 1), ("checksum", checksum, 16)):
        if position + width > size:
            raise MapError(f"The archive's {name} lies past its end")
    # The MIME list is NUL-terminated names ending in an empty name.
    raw_mime, position = b"", mime_list
    while True:
        if raw_mime.startswith(b"\0"):
            mime_types, mime_region_end = [], mime_list + 1
            break
        found = raw_mime.find(b"\0\0")
        if found >= 0:
            mime_types = [name.decode("utf-8", "replace") for name in raw_mime[:found].split(b"\0")]
            mime_region_end = mime_list + found + 2
            break
        if len(raw_mime) > MIME_LIST_LIMIT or position >= size:
            raise MapError("The MIME list is not terminated")
        chunk = reader.read(position, min(4096, size - position))
        raw_mime += chunk
        position += len(chunk)

    pointers = _from_little("Q", reader.read(path_pointers, 8 * entry_count))
    starts = _from_little("Q", reader.read(cluster_pointers, 8 * cluster_count))
    regions = [{"kind": "header", "start": 0, "end": HEADER.size},
               {"kind": "mime_list", "start": mime_list, "end": mime_region_end},
               {"kind": "path_pointers", "start": path_pointers, "end": path_pointers + 8 * entry_count},
               {"kind": "cluster_pointers", "start": cluster_pointers, "end": cluster_pointers + 8 * cluster_count}]
    if title_pointers not in (ABSENT, 0):
        if title_pointers + 4 * entry_count > size:
            raise MapError("The archive's title pointer list lies past its end")
        regions.append({"kind": "title_pointers", "start": title_pointers, "end": title_pointers + 4 * entry_count})

    entry_cluster = array.array("I", bytes(4 * entry_count))
    entry_mime = array.array("H", bytes(2 * entry_count))
    index_clusters, metadata_clusters, index_entries = set(), set(), []
    unsupported, first_content = 0, None
    window_start, window = 0, b""
    dirent_low, dirent_high = None, 0
    for index in range(entry_count):
        offset = pointers[index]
        if offset >= size:
            raise MapError(f"Directory entry {index} lies past the archive's end")
        while True:
            if not (window_start <= offset and offset + DIRENT_FIXED.size <= window_start + len(window)):
                window_start, window = offset, reader.read(offset, min(WINDOW, size - offset))
            local = offset - window_start
            if local + DIRENT_FIXED.size > len(window):
                raise MapError(f"Directory entry {index} is truncated by the archive's end")
            mimetype, parameter_length, namespace, _revision = DIRENT_FIXED.unpack_from(window, local)
            # A redirect carries its target index, a content entry its cluster and blob
            # numbers, and a link target or deleted entry nothing past the common header.
            fixed = 12 if mimetype == REDIRECT else DIRENT_FIXED.size if mimetype in (LINKTARGET, DELETED) else 16
            path_end = window.find(b"\0", local + fixed)
            title_end = window.find(b"\0", path_end + 1) if path_end >= 0 else -1
            end = title_end + 1 + parameter_length if title_end >= 0 else -1
            if 0 < end <= len(window) and end - local <= DIRENT_LIMIT:
                break
            # A window beginning at this entry holds far more than any entry needs, so
            # an entry still unterminated inside one is malformed, not merely unlucky.
            if window_start == offset:
                raise MapError(f"Directory entry {index} is not terminated")
            window_start, window = offset, reader.read(offset, min(WINDOW, size - offset))
        ns = namespace.decode("ascii", "replace")
        if first_content is None and ns == "C":
            first_content = index
        dirent_low = offset if dirent_low is None else min(dirent_low, offset)
        dirent_high = max(dirent_high, window_start + end)
        entry_mime[index] = mimetype
        if mimetype == REDIRECT:
            entry_cluster[index] = NO_CLUSTER
            continue
        if mimetype in (LINKTARGET, DELETED):
            entry_cluster[index] = NO_CLUSTER
            unsupported += 1
            continue
        cluster, = struct.unpack_from("<I", window, local + 8)
        if cluster >= cluster_count:
            raise MapError(f"Directory entry {index} names cluster {cluster} of {cluster_count}")
        entry_cluster[index] = cluster
        if ns in INDEX_NAMESPACES:
            index_clusters.add(cluster)
            index_entries.append(index)
        elif ns in METADATA_NAMESPACES:
            metadata_clusters.add(cluster)
    if entry_count:
        regions.append({"kind": "dirents", "start": dirent_low, "end": dirent_high})

    # A cluster's extent is not stored; it ends where the next thing begins. Clusters are
    # contiguous in practice, and the last one ends at the next structural region.
    boundaries = sorted({*starts, *(region["start"] for region in regions), checksum, size})
    ends = array.array("Q", bytes(8 * cluster_count))
    for cluster, start in enumerate(starts):
        following = bisect_right(boundaries, start)
        ends[cluster] = boundaries[following] if following < len(boundaries) else size
    header = {"schema": "almanac-zim-map-v1", "bytes": size, "major": major, "minor": minor,
              "entry_count": entry_count, "cluster_count": cluster_count, "mime_types": mime_types,
              "regions": regions, "checksum": {"start": checksum, "end": checksum + 16},
              "index_clusters": sorted(index_clusters), "metadata_clusters": sorted(metadata_clusters),
              "index_entries": index_entries, "unsupported_dirents": unsupported,
              # libzim addresses entries by their position in the path-ordered list, which is
              # what document identities carry. An archive whose content namespace does not
              # begin that list would offset them, and nothing here has verified such a layout.
              "entry_ids": "path_order" if minor < 1 or first_content in (None, 0) else "offset_unverified"}
    encoded = json.dumps(header, sort_keys=True, separators=(",", ":")).encode()
    return b"".join([MAP_MAGIC, struct.pack("<Q", len(encoded)), encoded, _native(starts), _native(ends),
                     _native(entry_cluster), _native(entry_mime)])


def write(path: Path, payload: bytes) -> str:
    """Store a map durably and return the SHA-256 the state records for it."""
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + "." + uuid.uuid4().hex + ".tmp")
    try:
        with temporary.open("wb") as stream:
            stream.write(payload)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)
    return hashlib.sha256(payload).hexdigest()


class StructureMap:
    """A verified map, read in place without loading its per-entry arrays into memory."""

    def __init__(self, path: Path, expected_sha256: str):
        with open(path, "rb") as stream:
            self.view = mmap.mmap(stream.fileno(), 0, access=mmap.ACCESS_READ)
        if hashlib.sha256(self.view).hexdigest() != expected_sha256:
            self.view.close()
            raise MapError(f"Structure map {path} does not match the digest recorded at admission")
        if self.view[:len(MAP_MAGIC)] != MAP_MAGIC:
            raise MapError("Structure map has an unknown format")
        length, = struct.unpack_from("<Q", self.view, len(MAP_MAGIC))
        start = len(MAP_MAGIC) + 8
        self.header = json.loads(self.view[start:start + length])
        self.size = self.header["bytes"]
        clusters, entries = self.header["cluster_count"], self.header["entry_count"]
        self.starts_at = start + length
        self.ends_at = self.starts_at + 8 * clusters
        self.clusters_at = self.ends_at + 8 * clusters
        self.mimes_at = self.clusters_at + 4 * entries
        self.regions = [(region["start"], region["end"], region["kind"]) for region in self.header["regions"]]
        self.index_clusters = set(self.header["index_clusters"])
        self.metadata_clusters = set(self.header["metadata_clusters"])
        self._order = self._sorted_starts = None

    def close(self):
        self.view.close()

    def cluster_extent(self, cluster):
        start, = struct.unpack_from("<Q", self.view, self.starts_at + 8 * cluster)
        end, = struct.unpack_from("<Q", self.view, self.ends_at + 8 * cluster)
        return start, end

    def entry_cluster(self, entry):
        if not 0 <= entry < self.header["entry_count"]:
            return None
        cluster, = struct.unpack_from("<I", self.view, self.clusters_at + 4 * entry)
        return None if cluster == NO_CLUSTER else cluster

    def entry_mime(self, entry):
        mime, = struct.unpack_from("<H", self.view, self.mimes_at + 2 * entry)
        return mime

    def entry_extent(self, entry):
        cluster = self.entry_cluster(entry)
        return None if cluster is None else self.cluster_extent(cluster)

    def entry_leaves(self, entry, leaf_bytes):
        """Every leaf holding any byte of the cluster an entry decompresses from."""
        extent = self.entry_extent(entry)
        if extent is None:
            return range(0)
        start, end = extent
        return range(start // leaf_bytes, max(start, end - 1) // leaf_bytes + 1)

    def classify(self, start, end):
        """What damage to bytes `[start, end)` costs, from the structure recorded at admission."""
        structural = [kind for low, high, kind in self.regions if low < end and start < high]
        clusters = self.clusters_overlapping(start, end)
        if any(cluster in self.metadata_clusters for cluster in clusters):
            structural.append("metadata")
        lexical = any(cluster in self.index_clusters for cluster in clusters)
        checksum = self.header["checksum"]
        trailer = checksum["start"] < end and start < checksum["end"]
        damage_class = (STRUCTURAL if structural or self.header["entry_ids"] != "path_order"
                        or self.header["unsupported_dirents"] else INDEX if lexical else DOCUMENT if clusters
                        else TRAILER if trailer else None)
        return {"class": damage_class, "structural_regions": sorted(set(structural)), "lexical": lexical,
                "clusters": clusters}

    def clusters_overlapping(self, start, end):
        if self._order is None:
            count = self.header["cluster_count"]
            starts = _from_little("Q", self.view[self.starts_at:self.starts_at + 8 * count])
            self._order = sorted(range(count), key=starts.__getitem__)
            self._sorted_starts = [starts[cluster] for cluster in self._order]
        found = []
        # Extents do not overlap, so everything overlapping [start, end) begins before `end`
        # and at or after the last extent beginning at or before `start`.
        position = max(0, bisect_right(self._sorted_starts, start) - 1)
        while position < len(self._order) and self._sorted_starts[position] < end:
            cluster = self._order[position]
            low, high = self.cluster_extent(cluster)
            if low < end and start < high:
                found.append(cluster)
            position += 1
        return sorted(found)

    def entries_in(self, clusters):
        """Entries whose content lies in any of these clusters: a full scan, for reports only."""
        wanted = set(clusters)
        if not wanted:
            return []
        entries = self.header["entry_count"]
        values = _from_little("I", self.view[self.clusters_at:self.clusters_at + 4 * entries])
        return [entry for entry, cluster in enumerate(values) if cluster in wanted]
