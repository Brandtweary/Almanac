#!/usr/bin/env python3
"""Read a published ZIM's own header and metadata over HTTP range requests.

A pack manifest declares what indexing an archive will cost, and that cost is a
function of how many articles the archive holds. The archive states that itself
in its `M/Counter` metadata entry, so the count is readable from the published
file without acquiring it: the header gives the path-pointer list, a binary
search over that list finds the entry, and one cluster read decodes it. Checking
a 52 GB archive's article count that way costs tens of kilobytes.

    PYTHONPATH=. python tools/inspect_remote_zim.py https://example.org/archive.zim

It counts with the ingest's own rule, imported rather than restated, so a footprint
derived here cannot disagree with the index built from it. Kiwix archives compress
their clusters with zstd, so this needs the `extraction` extra installed.

The ZIM format is documented at https://wiki.openzim.org/wiki/ZIM_file_format .
"""
from __future__ import annotations

import argparse
import json
import lzma
import struct
import sys
import urllib.error
import urllib.request

from oracle_content.native import counted_html_entries

MAGIC = 72173914
HEADER = struct.Struct("<IHH16sIIQQQQII")
ENTRY_READ = 1024
ENTRY_READ_LIMIT = 256 * 1024
CLUSTER_READ = 4 * 1024 * 1024
DECOMPRESSED_LIMIT = 16 * 1024 * 1024


class Ranged:
    """One published file, read in explicit byte ranges and never in full."""

    def __init__(self, url, opener=None, timeout=60):
        # Resolved here rather than captured as a default, so a caller that replaces
        # urlopen actually replaces it and nothing reaches the network unasked.
        self.url, self.timeout = url, timeout
        self.opener = opener or urllib.request.urlopen
        self.requests, self.fetched_bytes = 0, 0

    def read(self, start, length):
        """Whatever the origin returned for this range, having confirmed it is that range.

        A deliberate over-read past the end of the file comes back short and that is
        fine; what is never fine is bytes from somewhere else, so the origin's own
        `Content-Range` is compared with what was asked for before anything parses it.
        """
        request = urllib.request.Request(self.url, headers={
            "Range": f"bytes={start}-{start + length - 1}", "Accept-Encoding": "identity"})
        with self.opener(request, timeout=self.timeout) as response:
            if response.status != 206:
                raise ValueError(f"{self.url} served {response.status} for a range request; "
                                 "a whole-file response cannot be inspected this way")
            served = response.headers.get("Content-Range")
            payload = response.read()
        if served is not None and not served.startswith(f"bytes {start}-"):
            raise ValueError(f"{self.url} answered a request for byte {start} with {served!r}")
        if not payload:
            raise ValueError(f"{self.url} returned no bytes for the range beginning at {start}")
        self.requests += 1
        self.fetched_bytes += len(payload)
        return payload

    def read_exact(self, start, length):
        """A fixed-width structure, refused rather than misparsed when it comes back short."""
        payload = self.read(start, length)
        if len(payload) != length:
            raise ValueError(f"{self.url} returned {len(payload)} of {length} bytes at {start}; "
                             "the archive is truncated or the origin is not serving exact ranges")
        return payload


def header(source: Ranged) -> dict:
    raw = source.read_exact(0, HEADER.size)
    (magic, major, minor, uuid, entry_count, cluster_count, path_pointers,
     title_pointers, cluster_pointers, mime_list, main_page, layout_page) = HEADER.unpack(raw)
    if magic != MAGIC:
        raise ValueError("Not a ZIM archive: the magic number does not match")
    checksum_position, = struct.unpack_from("<Q", source.read_exact(72, 8))
    return {"major_version": major, "minor_version": minor, "uuid": uuid.hex(),
            "entry_count": entry_count, "cluster_count": cluster_count,
            "path_pointers": path_pointers, "cluster_pointers": cluster_pointers,
            "mime_list": mime_list, "checksum_position": checksum_position}


def strings(body: bytes, count: int):
    """The first `count` NUL-terminated strings, or None when the buffer ends inside one."""
    found, start = [], 0
    for _each in range(count):
        end = body.find(b"\0", start)
        if end < 0:
            return None
        found.append(body[start:end].decode("utf-8", "replace"))
        start = end + 1
    return found


def entry(source: Ranged, head: dict, index: int) -> dict:
    """The directory entry at a position in the path-pointer list.

    An entry is variable length — a path and a title of no fixed size — so the read
    widens until both are terminated inside it rather than guessing once. The limit
    bounds a malformed archive instead of reading it whole.
    """
    offset, = struct.unpack("<Q", source.read_exact(head["path_pointers"] + 8 * index, 8))
    width = ENTRY_READ
    while True:
        raw = source.read(offset, width)
        mimetype, _parameter_length, namespace = struct.unpack_from("<HBc", raw)
        redirect = mimetype == 0xFFFF
        header_width = 12 if redirect else 16
        found = strings(raw[header_width:], 1 if redirect else 2)
        if found is not None:
            break
        if width >= ENTRY_READ_LIMIT or len(raw) < width:
            raise ValueError(f"Directory entry {index} is not terminated within "
                             f"{len(raw)} bytes; the archive or the served range is malformed")
        width *= 4
    if redirect:
        return {"kind": "redirect", "namespace": namespace.decode(), "path": found[0]}
    _revision, cluster, blob = struct.unpack_from("<III", raw, 4)
    return {"kind": "article", "namespace": namespace.decode(), "path": found[0],
            "title": found[1], "mimetype": mimetype, "cluster": cluster, "blob": blob}


def locate(source: Ranged, head: dict, namespace: str, path: str):
    """Binary search the path-pointer list, which the format keeps sorted by namespace and path."""
    wanted, low, high = (namespace, path), 0, head["entry_count"] - 1
    while low <= high:
        middle = (low + high) // 2
        found = entry(source, head, middle)
        key = (found["namespace"], found["path"])
        if key == wanted:
            return found
        low, high = (middle + 1, high) if key < wanted else (low, middle - 1)
    return None


def blob(source: Ranged, head: dict, cluster: int, index: int) -> bytes:
    start, = struct.unpack("<Q", source.read(head["cluster_pointers"] + 8 * cluster, 8))
    if cluster + 1 < head["cluster_count"]:
        end, = struct.unpack("<Q", source.read(head["cluster_pointers"] + 8 * (cluster + 1), 8))
    else:
        end = head["checksum_position"]
    requested = min(end - start, CLUSTER_READ)
    raw = source.read(start, requested)
    information, body = raw[0], raw[1:]
    compression, extended = information & 0x0F, bool(information & 0x10)
    if compression in (0, 1):
        pass
    elif compression == 4:
        body = lzma.LZMADecompressor().decompress(body, DECOMPRESSED_LIMIT)
    elif compression == 5:
        import zstandard
        body = zstandard.ZstdDecompressor().stream_reader(body).read(DECOMPRESSED_LIMIT)
    else:
        raise ValueError(f"Unsupported cluster compression {compression}")
    width, layout = (8, "<Q") if extended else (4, "<I")
    if len(body) < width * (index + 2):
        raise ValueError("Cluster offset table is past this tool's bounded read; "
                         "the blob cannot be located rather than being guessed at")
    first, = struct.unpack_from(layout, body)
    if not 0 <= index < first // width - 1:
        raise ValueError("Blob index outside its cluster")
    start_offset, = struct.unpack_from(layout, body, width * index)
    end_offset, = struct.unpack_from(layout, body, width * (index + 1))
    # A short slice here would read as a shorter counter rather than as a failure,
    # and a truncated counter produces a wrong article count that looks measured.
    if end_offset > len(body):
        raise ValueError(f"Blob {index} ends at {end_offset} beyond the {len(body)} bytes read; "
                         "raise the read bounds rather than reporting a truncated value")
    return body[start_offset:end_offset]


def inspect(url: str, opener=None) -> dict:
    source = Ranged(url, opener)
    head = header(source)
    found = locate(source, head, "M", "Counter")
    counter = blob(source, head, found["cluster"], found["blob"]).decode("utf-8") if found else None
    return {"url": url, **head, "counter": counter,
            "indexed_html_entries": counted_html_entries(counter),
            "range_requests": source.requests, "fetched_bytes": source.fetched_bytes}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("url", nargs="+", help="published ZIM URLs served with range support")
    arguments = parser.parse_args(argv)
    reports = []
    for url in arguments.url:
        try:
            reports.append(inspect(url))
        except (urllib.error.URLError, OSError, ValueError, struct.error) as failure:
            # A mirror that refuses one hop is ordinary; the run reports which URL failed
            # and why, keeps whatever else succeeded, and exits nonzero.
            print(f"{url}: {type(failure).__name__}: {failure}", file=sys.stderr)
            reports.append({"url": url, "error": f"{type(failure).__name__}: {failure}"})
    print(json.dumps(reports, indent=2))
    return 1 if any("error" in report for report in reports) else 0


if __name__ == "__main__":
    sys.exit(main())
