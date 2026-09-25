"""Watching upstream: whether each source still serves an artifact, and whether it has moved on.

For an upstream pin the manifest is the publisher's own integrity data restated at
finer grain: admission accepts a leaf list only when the whole file matches the
publisher's SHA-256 and every leaf matches its published piece hash, so anyone can
reproduce the list from the publisher's file. The installation is a copy of a published
edition that can prove it is a faithful one, and it can be mended from the publisher
only while the publisher still lists that edition.

Two network checks, both run apart from the offline scrub:
- Source probes send a HEAD request to each byte source and record whether it still
  serves the artifact at its size with a strong validator, so a source's retirement
  shows up before a mend needs it.
- Successor detection reads the upstream directory listing an artifact's record names
  and reports a newer edition of the same archive when one is listed, and whether the
  installed edition is still listed at all.

Neither acts: detection reports, so a refresh to a newer edition can be planned while the
installed one can still be fetched; moving to a new edition is an installation step.
"""
from __future__ import annotations

import json
import re
import urllib.request
from pathlib import Path
from urllib.parse import urljoin

from .admit import integrity_dir
from .manifest import Manifest, ManifestDamaged
from .sources import TIMEOUT, USER_AGENT, network_sources, probe
from .state import State

LISTING_LIMIT = 8 * 1024 * 1024
EDITION = re.compile(r"^(?P<name>.+)_(?P<edition>\d{4}-\d{2})\.zim$")


def listing_source(url: str):
    """The upstream-listing source implied by a Kiwix-style `<name>_<YYYY-MM>.zim` URL, or None."""
    filename = url.rsplit("/", 1)[-1]
    if filename.endswith(".meta4"):
        filename = filename[:-len(".meta4")]
    match = EDITION.match(filename)
    if not match or not url.startswith("https://"):
        return None
    return {"type": "upstream-listing", "url": url.rsplit("/", 1)[0] + "/", "name": match["name"],
            "edition": match["edition"]}


def successor(listing: dict, *, opener=None) -> dict:
    """Read a directory listing and compare the editions it lists with the installed one."""
    opener = opener or urllib.request.urlopen
    request = urllib.request.Request(listing["url"], headers={"User-Agent": USER_AGENT})
    with opener(request, timeout=TIMEOUT) as response:
        if response.status != 200:
            raise OSError(f"{listing['url']} served {response.status}")
        body = response.read(LISTING_LIMIT + 1)
    if len(body) > LISTING_LIMIT:
        raise OSError(f"{listing['url']} listing exceeds {LISTING_LIMIT} bytes")
    pattern = re.compile(r'href="(?:[^"]*/)?(' + re.escape(listing["name"]) + r'_(\d{4}-\d{2})\.zim)"')
    listed = {edition: urljoin(listing["url"], name) for name, edition in pattern.findall(body.decode("utf-8", "replace"))}
    newer = sorted(edition for edition in listed if edition > listing["edition"])
    latest = newer[-1] if newer else None
    return {"pinned_edition": listing["edition"], "pinned_listed": listing["edition"] in listed,
            "listed_editions": sorted(listed),
            "successor": {"edition": latest, "url": listed[latest]} if latest else None}


def probe_all(store_root: Path, manifest_dir: Path, *, opener=None) -> dict:
    """Probe every source of every committed artifact this installation holds."""
    state = State(integrity_dir(store_root))
    results = {}
    try:
        try:
            manifest = Manifest(manifest_dir)
        except ManifestDamaged as error:
            state.event("manifest_damaged", error=str(error), action="no probes")
            return {"error": str(error)}
        for record in manifest.records():
            sha = record["sha256"]
            if state.artifact(sha) is None:
                continue
            report = results.setdefault(sha, {})
            for source in network_sources(record, leaf_bytes=manifest.leaf_bytes, opener=opener):
                verdict = probe(source, opener=opener)
                state.record_probe(sha, source.name, verdict["ok"], results=verdict["results"])
                report[source.name] = verdict["ok"]
            for listing in (source for source in record.get("sources", []) if source.get("type") == "upstream-listing"):
                key = "successor:" + listing["url"]
                try:
                    found = successor(listing, opener=opener)
                except (OSError, ValueError) as error:
                    state.record_probe(sha, key, False, error=f"{type(error).__name__}: {error}")
                    report[key] = {"error": str(error)}
                    continue
                prior = state.db.execute("SELECT detail FROM source_probe WHERE artifact=? AND source=? AND ok=1",
                                         (sha, key)).fetchone()
                prior = json.loads(prior[0]) if prior and prior[0] else {}
                state.record_probe(sha, key, True, **found)
                # Events mark changes; the probe row always holds the latest reading.
                if found["successor"] is not None and found["successor"] != prior.get("successor"):
                    state.event("upstream_successor_listed", sha, **found["successor"])
                if not found["pinned_listed"] and prior.get("pinned_listed", True):
                    state.event("upstream_pin_unlisted", sha, edition=listing["edition"])
                report[key] = found
        return results
    finally:
        state.close()
