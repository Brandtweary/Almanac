"""Where replacement bytes for a damaged leaf can come from. None of these is trusted.

Content addressing is what makes every source untrusted and still usable: the
manifest says what leaf *i* must hash to, so a candidate from anywhere is accepted
only if it is exactly the leaf's length and hashes to `leaves[i]`. A source can waste
a request; it can never cause a wrong write.

Sources, tried in order: local parity, which needs no network; the upstream mirrors,
read by HTTP range for exactly one leaf; and, for artifacts built locally, a copy kept
as leaf-aligned release parts.
"""
from __future__ import annotations

import hashlib
import re
import urllib.request

from .tree import leaf_count, leaf_hash, leaf_span

TIMEOUT = 60
USER_AGENT = "almanac-integrity/1"
# A release asset must be smaller than 2 GiB, so a part holds at most this many bytes.
RELEASE_ASSET_LIMIT = 2 * 1024 ** 3 - 1


class SourceFailure(Exception):
    """A source could not supply a candidate for a leaf."""


def accept(candidate: bytes, expected: bytes, length: int) -> bool:
    """The only test any replacement bytes ever pass: exact length and the manifest's leaf hash."""
    return isinstance(candidate, bytes) and len(candidate) == length and leaf_hash(candidate) == expected


def ranged(opener, url: str, start: int, length: int, *, total: int | None) -> bytes:
    """Exactly `length` bytes at `start`, having confirmed the origin served that range.

    The status must be 206, the `Content-Range` must name exactly this range (and the
    total, when it is known), and the body must be exactly that long: a whole-file
    response or bytes from anywhere else are refused before anything reads them.
    """
    last = start + length - 1
    request = urllib.request.Request(url, headers={"Range": f"bytes={start}-{last}", "Accept-Encoding": "identity",
                                                   "User-Agent": USER_AGENT})
    try:
        with opener(request, timeout=TIMEOUT) as response:
            if response.status != 206:
                raise SourceFailure(f"{url} served {response.status} for a range request")
            served = response.headers.get("Content-Range") or ""
            match = re.fullmatch(r"bytes ([0-9]+)-([0-9]+)/([0-9]+|\*)", served)
            if not match or int(match[1]) != start or int(match[2]) != last or (
                    total is not None and match[3] != str(total)):
                raise SourceFailure(f"{url} answered bytes {start}-{last} with {served!r}")
            payload = response.read(length + 1)
    except SourceFailure:
        raise
    except (OSError, ValueError) as error:
        raise SourceFailure(f"{url}: {type(error).__name__}: {error}") from None
    if len(payload) != length:
        raise SourceFailure(f"{url} returned {len(payload)} bytes for a {length}-byte range")
    return payload


class ParitySource:
    kind = "parity"

    def __init__(self, reconstruct):
        self.name, self.reconstruct = "parity", reconstruct

    def fetch(self, index: int) -> bytes:
        try:
            return self.reconstruct(index)
        except (OSError, ValueError, EOFError) as error:
            raise SourceFailure(f"parity: {error}") from None

    def crosscheck(self, index, candidate):
        return None


class RangeSource:
    """One upstream mirror of the whole artifact."""
    kind = "http-range"

    def __init__(self, url, *, size, leaf_bytes, opener=None, upstream_sha1=None):
        self.name, self.url, self.size, self.leaf_bytes = url, url, size, leaf_bytes
        self.opener = opener or urllib.request.urlopen
        self.upstream_sha1 = upstream_sha1

    def fetch(self, index: int) -> bytes:
        start, stop = leaf_span(index, self.size, self.leaf_bytes)
        return ranged(self.opener, self.url, start, stop - start, total=self.size)

    def crosscheck(self, index: int, candidate: bytes):
        """The upstream piece hash for this leaf, compared as a cross-check and never as authority."""
        if self.upstream_sha1 is None or index >= len(self.upstream_sha1):
            return None
        return hashlib.sha1(candidate).digest() == self.upstream_sha1[index]


def release_parts(urls, *, size: int, leaf_bytes: int, leaves_per_part: int | None = None) -> dict:
    """The `release-parts` source entry for an artifact cut into leaf-aligned parts, one URL per part in order.

    Part *n* holds leaves `[n·k, (n+1)·k)` for `k` leaves per part, the most whole leaves
    under the release asset limit unless named, so cutting the artifact every `k·leaf_bytes`
    bytes produces exactly these parts.
    """
    per_part = leaves_per_part or RELEASE_ASSET_LIMIT // leaf_bytes
    if per_part < 1 or per_part * leaf_bytes > RELEASE_ASSET_LIMIT:
        raise ValueError(f"A part of {per_part} leaves of {leaf_bytes} bytes does not fit one release asset")
    total = leaf_count(size, leaf_bytes)
    expected = -(-total // per_part)
    urls = list(urls)
    if len(urls) != expected:
        raise ValueError(f"{total} leaves at {per_part} per part make {expected} parts; {len(urls)} URLs were given")
    if not all(isinstance(url, str) and url.startswith("https://") for url in urls):
        raise ValueError("Every release part URL must be https")
    return {"type": "release-parts", "parts": [
        {"url": url, "first_leaf": number * per_part, "leaf_count": min(per_part, total - number * per_part)}
        for number, url in enumerate(urls)]}


class ReleasePartsSource:
    """A locally built artifact kept as leaf-aligned parts, each under a size limit."""
    kind = "release-parts"

    def __init__(self, parts, *, size, leaf_bytes, opener=None, name="release-parts"):
        self.name, self.parts, self.size, self.leaf_bytes = name, parts, size, leaf_bytes
        self.opener = opener or urllib.request.urlopen

    def locate(self, index: int):
        for part in self.parts:
            if part["first_leaf"] <= index < part["first_leaf"] + part["leaf_count"]:
                return part
        raise SourceFailure(f"No release part holds leaf {index}")

    def fetch(self, index: int) -> bytes:
        part = self.locate(index)
        start, stop = leaf_span(index, self.size, self.leaf_bytes)
        offset = (index - part["first_leaf"]) * self.leaf_bytes
        first, last_leaf = part["first_leaf"], part["first_leaf"] + part["leaf_count"] - 1
        part_bytes = leaf_span(last_leaf, self.size, self.leaf_bytes)[1] - first * self.leaf_bytes
        return ranged(self.opener, part["url"], offset, stop - start, total=part_bytes)

    def crosscheck(self, index, candidate):
        return None


def network_sources(record: dict, *, leaf_bytes: int, opener=None, upstream_sha1=None) -> list:
    """The manifest record's fetchable sources, in the order it lists them."""
    found = []
    for source in record.get("sources", []):
        if source.get("type") == "http-range" and isinstance(source.get("url"), str) and source["url"].startswith("https://"):
            found.append(RangeSource(source["url"], size=record["bytes"], leaf_bytes=leaf_bytes, opener=opener,
                                     upstream_sha1=upstream_sha1))
        elif source.get("type") == "release-parts" and isinstance(source.get("parts"), list):
            parts = [part for part in source["parts"] if isinstance(part.get("url"), str) and part["url"].startswith("https://")]
            if parts:
                found.append(ReleasePartsSource(parts, size=record["bytes"], leaf_bytes=leaf_bytes, opener=opener,
                                                name=source.get("tag") or "release-parts"))
    return found


def probe(source, *, opener=None) -> dict:
    """Whether a source still serves this artifact, by size and strong validator, without fetching it."""
    opener = opener or urllib.request.urlopen
    targets = ([(source.url, source.size)] if isinstance(source, RangeSource) else
               [(part["url"], leaf_span(part["first_leaf"] + part["leaf_count"] - 1, source.size, source.leaf_bytes)[1]
                 - part["first_leaf"] * source.leaf_bytes) for part in source.parts])
    results = []
    for url, expected in targets:
        request = urllib.request.Request(url, method="HEAD", headers={"User-Agent": USER_AGENT})
        try:
            with opener(request, timeout=TIMEOUT) as response:
                length, etag = response.headers.get("Content-Length"), response.headers.get("ETag")
                results.append({"url": url, "status": response.status, "bytes": length, "etag": etag,
                                "ok": response.status == 200 and length == str(expected) and bool(etag)
                                and not etag.startswith("W/")})
        except (OSError, ValueError) as error:
            results.append({"url": url, "ok": False, "error": f"{type(error).__name__}: {error}"})
    return {"ok": all(result["ok"] for result in results), "results": results}
