#!/usr/bin/env python3
"""Read a published ZIM's own header and metadata over HTTP range requests.

A pack manifest declares what indexing an archive will cost, and that cost is a
function of how many articles the archive holds. The archive states that itself
in its `M/Counter` metadata entry, so the count is readable from the published
file without acquiring it: the header gives the path-pointer list, a binary
search over that list finds the entry, and one cluster read decodes it. Checking
a 52 GB archive's article count that way costs tens of kilobytes.

    python tools/inspect_remote_zim.py https://example.org/archive.zim

The ZIM format is documented at https://wiki.openzim.org/wiki/ZIM_file_format .
"""
from __future__ import annotations

import argparse
import json
import lzma
import re
import struct
import urllib.request

MAGIC = 72173914
HEADER = struct.Struct("<IHH16sIIQQQQII")
ENTRY_READ = 1024
CLUSTER_READ = 4 * 1024 * 1024
# The mimetype counts a compact native generation indexes: one vector per HTML
# article, matching the selection `oracle_content.native` applies at ingest.
INDEXED_MIME = re.compile(r"(?:^|;)(text/html(?:;[^=;]+=[^;]+)*|application/xhtml\+xml)=(\d+)(?=;|$)")


class Ranged:
    """One published file, read in explicit byte ranges and never in full."""

    def __init__(self, url, opener=urllib.request.urlopen, timeout=60):
        self.url, self.opener, self.timeout = url, opener, timeout
        self.requests, self.fetched_bytes = 0, 0

    def read(self, start, length):
        request = urllib.request.Request(self.url, headers={
            "Range": f"bytes={start}-{start + length - 1}", "Accept-Encoding": "identity"})
        with self.opener(request, timeout=self.timeout) as response:
            if response.status != 206:
                raise ValueError(f"{self.url} served {response.status} for a range request; "
                                 "a whole-file response cannot be inspected this way")
            payload = response.read()
        self.requests += 1
        self.fetched_bytes += len(payload)
        return payload


def header(source: Ranged) -> dict:
    raw = source.read(0, HEADER.size)
    (magic, major, minor, uuid, entry_count, cluster_count, path_pointers,
     title_pointers, cluster_pointers, mime_list, main_page, layout_page) = HEADER.unpack(raw)
    if magic != MAGIC:
        raise ValueError("Not a ZIM archive: the magic number does not match")
    checksum_position, = struct.unpack_from("<Q", source.read(72, 8))
    return {"major_version": major, "minor_version": minor, "uuid": uuid.hex(),
            "entry_count": entry_count, "cluster_count": cluster_count,
            "path_pointers": path_pointers, "cluster_pointers": cluster_pointers,
            "mime_list": mime_list, "checksum_position": checksum_position}


def entry(source: Ranged, head: dict, index: int) -> dict:
    """The directory entry at a position in the path-pointer list."""
    offset, = struct.unpack("<Q", source.read(head["path_pointers"] + 8 * index, 8))
    raw = source.read(offset, ENTRY_READ)
    mimetype, _parameter_length, namespace = struct.unpack_from("<HBc", raw)
    if mimetype == 0xFFFF:
        body = raw[12:]
        return {"kind": "redirect", "namespace": namespace.decode(),
                "path": body[:body.index(b"\0")].decode("utf-8", "replace")}
    _revision, cluster, blob = struct.unpack_from("<III", raw, 4)
    body = raw[16:]
    path = body[:body.index(b"\0")].decode("utf-8", "replace")
    return {"kind": "article", "namespace": namespace.decode(), "path": path,
            "mimetype": mimetype, "cluster": cluster, "blob": blob}


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
    raw = source.read(start, min(end - start, CLUSTER_READ))
    information, body = raw[0], raw[1:]
    compression, extended = information & 0x0F, bool(information & 0x10)
    if compression in (0, 1):
        pass
    elif compression == 4:
        body = lzma.LZMADecompressor().decompress(body, CLUSTER_READ * 2)
    elif compression == 5:
        import zstandard
        body = zstandard.ZstdDecompressor().stream_reader(body).read(CLUSTER_READ * 2)
    else:
        raise ValueError(f"Unsupported cluster compression {compression}")
    width, layout = (8, "<Q") if extended else (4, "<I")
    first, = struct.unpack_from(layout, body)
    if not 0 <= index < first // width - 1:
        raise ValueError("Blob index outside its cluster")
    start_offset, = struct.unpack_from(layout, body, width * index)
    end_offset, = struct.unpack_from(layout, body, width * (index + 1))
    return body[start_offset:end_offset]


def inspect(url: str, opener=urllib.request.urlopen) -> dict:
    source = Ranged(url, opener)
    head = header(source)
    found = locate(source, head, "M", "Counter")
    counter = blob(source, head, found["cluster"], found["blob"]).decode("utf-8") if found else None
    indexed = sum(int(number) for _mime, number in INDEXED_MIME.findall(counter)) if counter else None
    return {"url": url, **head, "counter": counter, "indexed_html_entries": indexed,
            "range_requests": source.requests, "fetched_bytes": source.fetched_bytes}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("url", nargs="+", help="published ZIM URLs served with range support")
    arguments = parser.parse_args(argv)
    print(json.dumps([inspect(url) for url in arguments.url], indent=2))


if __name__ == "__main__":
    main()
