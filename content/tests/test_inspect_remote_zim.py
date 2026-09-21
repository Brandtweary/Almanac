"""The remote inspector reads a published archive's counts without acquiring it."""
import struct
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from tools import inspect_remote_zim as remote  # noqa: E402

COUNTER = ("application/pdf=3;text/html=13220;text/html; charset=UTF-8=15;"
           "text/html; charset=iso-8859-1=1;image/png=7")


def archive(counter: str = COUNTER, entries=(("M", "Counter"),)) -> bytes:
    """A minimal well-formed ZIM whose one cluster is stored uncompressed."""
    body = counter.encode()
    offsets = struct.pack("<II", 8, 8 + len(body))
    cluster = bytes([1]) + offsets + body

    directory, positions = b"", []
    for namespace, path in sorted(entries):
        positions.append(len(directory))
        directory += struct.pack("<HBc", 0, 0, namespace.encode()) + struct.pack("<III", 0, 0, 0)
        directory += path.encode() + b"\0" + path.encode() + b"\0"

    mime_list = b"text/html\0\0"
    head = bytearray(80)
    layout = [(0, mime_list), (0, directory), (0, cluster)]
    position = 80
    placed = []
    for _unused, block in layout:
        placed.append(position)
        position += len(block)
    mime_at, directory_at, cluster_at = placed
    path_pointers_at = position
    path_pointers = b"".join(struct.pack("<Q", directory_at + p) for p in positions)
    position += len(path_pointers)
    cluster_pointers_at = position
    cluster_pointers = struct.pack("<Q", cluster_at)
    position += len(cluster_pointers)

    struct.pack_into("<IHH16sIIQQQQII", head, 0, remote.MAGIC, 6, 3, b"u" * 16,
                     len(positions), 1, path_pointers_at, 0xFFFFFFFFFFFFFFFF,
                     cluster_pointers_at, mime_at, 0, 0)
    struct.pack_into("<Q", head, 72, position)
    return bytes(head) + mime_list + directory + cluster + path_pointers + cluster_pointers + b"\0" * 32


class Served:
    """A range-serving origin that records exactly which bytes were asked for."""

    def __init__(self, content, status=206):
        self.content, self.status, self.ranges = content, status, []

    def __call__(self, request, timeout=None):
        start, stop = request.headers["Range"].removeprefix("bytes=").split("-")
        start, stop = int(start), int(stop)
        self.ranges.append((start, stop))
        return self

    def __enter__(self):
        return self

    def __exit__(self, *unused):
        return False

    def read(self):
        start, stop = self.ranges[-1]
        return self.content[start:stop + 1]


def test_counter_is_read_from_a_fraction_of_the_archive():
    # The padding stands in for archive content: what is read must not scale with it.
    served = Served(archive() + b"\0" * (4 * 1024 * 1024))
    report = remote.inspect("https://example.org/a.zim", served)
    assert report["counter"] == COUNTER
    assert report["indexed_html_entries"] == 13220 + 15 + 1
    assert report["entry_count"] == 1
    assert report["fetched_bytes"] < len(served.content) // 100
    assert all(stop - start < len(served.content) // 100 for start, stop in served.ranges)


def test_binary_search_finds_a_metadata_entry_among_many():
    entries = [("C", f"article{index:04d}") for index in range(200)] + [("M", "Counter")]
    served = Served(archive(entries=entries))
    report = remote.inspect("https://example.org/a.zim", served)
    # The first entry sorts under C, so a linear scan would be the only other way here.
    assert report["indexed_html_entries"] == 13220 + 15 + 1
    assert len(served.ranges) < len(entries)


def test_a_whole_file_response_is_refused_rather_than_misparsed():
    served = Served(archive(), status=200)
    with pytest.raises(ValueError, match="range request"):
        remote.inspect("https://example.org/a.zim", served)


def test_a_file_that_is_not_a_zim_is_refused():
    served = Served(b"\0" * 4096)
    with pytest.raises(ValueError, match="magic number"):
        remote.inspect("https://example.org/a.zim", served)


def test_an_archive_without_a_counter_reports_no_count():
    served = Served(archive(entries=(("M", "Title"),)))
    report = remote.inspect("https://example.org/a.zim", served)
    assert report["counter"] is None and report["indexed_html_entries"] is None
