#!/usr/bin/env python3
"""Operator maintenance for corpus integrity: admit, scrub, mend, probe and report.

Every command reads `--data`, the content state directory the service runs from.
`--manifest-dir` is the committed integrity manifest, `deploy/integrity/` in the source
tree this file belongs to unless named.

    admit          one full read of an original: leaf list, parity, structure map; writes a candidate
    publish        merge an admitted candidate into a manifest directory for the commit flow
    admit-spans    record a published article-spans artifact's leaves for scrubbing
    scrub          re-read admitted leaves from the medium, offline, and record verdicts
    mend           recover interrupted mends, then repair damaged leaves from verified sources
    probe          check every byte source and the upstream listing for a newer edition
    validate-dense scroll each native generation's vector points against its manifest checksum
    run            one maintenance cycle: scrub, mend and probe
    report         the current account, with damaged documents named

Scrub, admission and mending read around the page cache and are held to `--rate` bytes
per second, because at full speed they saturate the disk the search service reads from.
Mending writes into originals unless `--no-artifact-writes` is given, in which case it
keeps each verified candidate under `integrity/held/` for a person to read and leaves
the leaf quarantined.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve()
sys.path.insert(0, str(HERE.parent.parent))

from oracle_content.integrity import admit as admission  # noqa: E402
from oracle_content.integrity.medium import RateLimit  # noqa: E402
from oracle_content.integrity.mend import mend_all  # noqa: E402
from oracle_content.integrity.parity import DEFAULT_GROUP  # noqa: E402
from oracle_content.integrity.report import report  # noqa: E402
from oracle_content.integrity.scrub import scrub  # noqa: E402
from oracle_content.integrity.state import State  # noqa: E402
from oracle_content.integrity.tree import LEAF_BYTES  # noqa: E402
from oracle_content.integrity.sources import release_parts  # noqa: E402
from oracle_content.integrity.upstream import listing_source, probe_all  # noqa: E402

MANIFEST_DIR = HERE.parents[2] / "deploy" / "integrity"
METALINK_LIMIT = 16 * 1024 * 1024


def fetch(url_or_path: str) -> bytes:
    if url_or_path.startswith("https://"):
        request = urllib.request.Request(url_or_path, headers={"User-Agent": "almanac-integrity/1"})
        with urllib.request.urlopen(request, timeout=60) as response:
            body = response.read(METALINK_LIMIT + 1)
        if len(body) > METALINK_LIMIT:
            raise SystemExit(f"{url_or_path} exceeds {METALINK_LIMIT} bytes")
        return body
    return Path(url_or_path).read_bytes()


def pack_artifact(pack: Path, sha256: str) -> dict:
    document = json.loads(pack.read_text())
    for artifact in document.get("artifacts", []):
        if artifact.get("sha256") == sha256:
            return artifact
    raise SystemExit(f"{pack} lists no artifact with SHA-256 {sha256}")


def sources_for(urls, metalink_url=None, parts=None):
    sources = [{"type": "http-range", "url": url} for url in urls if url.startswith("https://")]
    if parts is not None:
        sources.append(parts)
    for candidate in [metalink_url, *urls]:
        listing = listing_source(candidate) if candidate else None
        if listing is not None:
            sources.append(listing)
            break
    return sources


def parts_for(args, size, leaf_bytes):
    """The release-parts source the flags name, or None when they name no part."""
    if not args.release_part:
        return None
    try:
        return release_parts(args.release_part, size=size, leaf_bytes=leaf_bytes, leaves_per_part=args.leaves_per_part)
    except ValueError as error:
        raise SystemExit(str(error)) from None


def command_admit(args):
    metalink_url, urls, pack_path = args.metalink, list(args.source_url), args.pack_path
    if args.pack is not None:
        artifact = pack_artifact(args.pack, args.sha256)
        pack_path = pack_path or artifact["path"]
        listed = artifact.get("urls", [])
        urls = urls or ([listed] if isinstance(listed, str) else list(listed))
        metalink_url = metalink_url or (None if args.no_metalink else artifact.get("metalink"))
    if not pack_path:
        raise SystemExit("--pack-path is required when no --pack names the artifact")
    original = args.data / "originals" / args.sha256
    if not original.is_file():
        print(json.dumps({"admitted": False, "reason": "artifact_missing", "path": str(original)}, indent=2))
        return 1
    size = original.stat().st_size
    upstream = None
    if metalink_url and not args.no_metalink:
        upstream = admission.parse_metalink(fetch(metalink_url), size=size, sha256=args.sha256)
    parity_dir = args.parity_dir or (args.data / "integrity" / "parity")
    parts = parts_for(args, size, args.leaf_bytes)
    try:
        record = admission.admit(args.data, args.sha256, kind=args.kind, pack_path=pack_path,
                                 sources=sources_for(urls, metalink_url, parts), leaf_bytes=args.leaf_bytes,
                                 parity_dir=parity_dir, parity_group=args.parity_group, upstream=upstream,
                                 rate=RateLimit(args.rate))
    except admission.AdmissionRefused as refusal:
        print(json.dumps({"admitted": False, "reason": refusal.reason, **refusal.detail}, indent=2))
        return 1
    print(json.dumps({"admitted": True, "record": record}, indent=2))
    return 0


def command_publish(args):
    sources = None
    if args.release_part:
        record = json.loads((args.data / "integrity" / "candidates" / (args.sha256 + ".json")).read_text())
        corpus = json.loads((args.manifest_dir / "corpus.json").read_text())
        parts = parts_for(args, record["bytes"], corpus["leaf_bytes"])
        sources = [source for source in record.get("sources", []) if source.get("type") != "release-parts"] + [parts]
    document = admission.publish_candidate(args.data, args.sha256, args.manifest_dir, sources=sources)
    print(json.dumps({"corpus_root": document["corpus_root"], "artifacts": len(document["artifacts"])}, indent=2))
    return 0


def command_admit_spans(args):
    print(json.dumps(admission.admit_derived(args.data, args.generation, leaf_bytes=args.leaf_bytes,
                                             rate=RateLimit(args.rate)), indent=2))
    return 0


def command_scrub(args):
    print(json.dumps(scrub(args.data, args.manifest_dir, rate=RateLimit(args.rate), budget=args.budget,
                           artifacts=set(args.artifact) or None), indent=2))
    return 0


def command_mend(args):
    summary = mend_all(args.data, args.manifest_dir, rate=RateLimit(args.rate), write=not args.no_artifact_writes,
                       network=not args.no_network, artifacts=set(args.artifact) or None)
    print(json.dumps(summary, indent=2, default=str))
    return 0


def command_probe(args):
    print(json.dumps(probe_all(args.data, args.manifest_dir), indent=2))
    return 0


async def validate_dense(args):
    import httpx
    from oracle_content.adapters import Qdrant
    from oracle_content.models import Profile
    from oracle_content.native import KIND
    profile = Profile.model_validate_json(args.profile.read_text())
    state = State(args.data / "integrity")
    results = {}
    try:
        async with httpx.AsyncClient(timeout=profile.request_timeout, trust_env=False) as client:
            dense = Qdrant(client, args.qdrant_url, None, profile)
            for path in sorted((args.data / "generations").glob("*/manifest.json")):
                manifest = json.loads(path.read_text())
                if manifest.get("kind") != KIND or manifest.get("dense_stage") != "complete":
                    continue
                generation = manifest["generation"]
                started = time.monotonic()
                try:
                    await dense.validate_native(generation, manifest["indexed_articles"], manifest["point_checksum"])
                    ok, detail = True, {}
                except (ValueError, KeyError, httpx.HTTPError) as error:
                    ok, detail = False, {"error": f"{type(error).__name__}: {error}"}
                detail["seconds"] = round(time.monotonic() - started, 1)
                state.record_generation_check(generation, "dense", ok, **detail)
                results[generation] = {"ok": ok, **detail}
    finally:
        state.close()
    return results


def command_validate_dense(args):
    print(json.dumps(asyncio.run(validate_dense(args)), indent=2))
    return 0


def command_run(args):
    while True:
        cycle = {"scrub": scrub(args.data, args.manifest_dir, rate=RateLimit(args.rate), budget=args.budget),
                 "mend": mend_all(args.data, args.manifest_dir, rate=RateLimit(args.rate),
                                  write=not args.no_artifact_writes, network=not args.no_network)}
        if not args.no_network:
            cycle["probe"] = probe_all(args.data, args.manifest_dir)
        print(json.dumps(cycle, default=str), flush=True)
        if args.repeat_after is None:
            return 0
        time.sleep(args.repeat_after)


def command_report(args):
    print(json.dumps(report(args.data), indent=2, default=str))
    return 0


def release_part_flags(command, suffix=""):
    command.add_argument("--release-part", action="append", default=[],
                         help="HTTPS URL of one leaf-aligned release part, repeated in part order" + suffix)
    command.add_argument("--leaves-per-part", type=int,
                         help="Leaves in every part but the last; the most whole leaves under 2 GiB by default")


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0],
                                     formatter_class=argparse.RawDescriptionHelpFormatter, epilog=__doc__)
    parser.add_argument("--data", type=Path, required=True, help="Content state directory (CONTENT_STATE_DIR)")
    parser.add_argument("--manifest-dir", type=Path, default=MANIFEST_DIR, help="Committed integrity manifest")
    commands = parser.add_subparsers(dest="command", required=True)

    admit = commands.add_parser("admit", help="Admit one original by SHA-256")
    admit.add_argument("--sha256", required=True)
    admit.add_argument("--pack", type=Path, help="Pack manifest listing the artifact: supplies path, mirrors, metalink")
    admit.add_argument("--pack-path", help="Artifact path as a pack manifest names it")
    admit.add_argument("--kind", choices=("upstream", "derived"), default="upstream")
    admit.add_argument("--source-url", action="append", default=[], help="HTTPS mirror of the whole artifact")
    release_part_flags(admit)
    admit.add_argument("--metalink", help="Metalink URL or file carrying the upstream SHA-1 piece table")
    admit.add_argument("--no-metalink", action="store_true", help="Admit without the upstream piece cross-check")
    admit.add_argument("--parity-dir", type=Path, help="Parity directory; best on a different disk from the originals")
    admit.add_argument("--parity-group", type=int, default=DEFAULT_GROUP)
    admit.add_argument("--leaf-bytes", type=int, default=LEAF_BYTES)
    admit.add_argument("--rate", type=float, help="Read rate cap in bytes per second")
    admit.set_defaults(handler=command_admit)

    publish = commands.add_parser("publish", help="Merge an admitted candidate into --manifest-dir")
    publish.add_argument("--sha256", required=True)
    release_part_flags(publish, "; replaces the candidate's release parts")
    publish.set_defaults(handler=command_publish)

    spans = commands.add_parser("admit-spans", help="Record a completed article-spans artifact's leaves")
    spans.add_argument("--generation", required=True)
    spans.add_argument("--leaf-bytes", type=int, default=LEAF_BYTES)
    spans.add_argument("--rate", type=float)
    spans.set_defaults(handler=command_admit_spans)

    for name, handler in (("scrub", command_scrub), ("mend", command_mend), ("run", command_run)):
        sub = commands.add_parser(name)
        sub.set_defaults(handler=handler)
        sub.add_argument("--rate", type=float, help="Read rate cap in bytes per second")
        if name in ("scrub", "run"):
            sub.add_argument("--budget", type=int, help="Leaves to read in this call; the next call resumes the "
                             "artifact in progress, then the one scrubbed longest ago")
        if name in ("mend", "run"):
            sub.add_argument("--no-artifact-writes", action="store_true",
                             help="Hold verified candidates for review instead of writing them into originals")
            sub.add_argument("--no-network", action="store_true", help="Mend from local parity only")
        if name != "run":
            sub.add_argument("--artifact", action="append", default=[], help="Limit to one artifact id")
        else:
            sub.add_argument("--repeat-after", type=float, help="Seconds to wait between cycles; one cycle when absent")

    probe = commands.add_parser("probe", help="Probe byte sources and upstream listings")
    probe.set_defaults(handler=command_probe)

    dense = commands.add_parser("validate-dense", help="Validate native dense indexes against their checksums")
    dense.add_argument("--profile", type=Path, required=True)
    dense.add_argument("--qdrant-url", required=True)
    dense.set_defaults(handler=command_validate_dense)

    show = commands.add_parser("report", help="Print the integrity account")
    show.set_defaults(handler=command_report)

    args = parser.parse_args(argv)
    try:
        return args.handler(args)
    except urllib.error.URLError as error:
        print(f"network error: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
