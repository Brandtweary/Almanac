"""Write the inspection receipt a native preparation binds, from a sample of the archive.

`prepare_native.py` refuses an archive without a receipt naming its SHA-256, extraction
revision and selection policy. This draws a seeded sample of the archive's HTML entries,
runs each through the same extraction, lead and selection code the build uses, and records
what came out, so the receipt shows how the archive reads rather than asserting it.

    python tools/inspect_native.py --archive <zim> --sha256 <sha256> \\
        --selection-policy canonical-html --scope "<what was inspected>" \\
        --output inspections/<name>-html-v4.json [--sample 12] [--path <entry> ...]

Read the observations before preparing: a sample whose entries extract to no blocks, no lead
or navigation chrome is an archive the policy should not admit as it stands.
"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import random

from libzim.reader import Archive

from oracle_content.extract import decode_zim_html, html_blocks
from oracle_content.native import POLICIES, article_lead, html_type, selection

REVISION = "html-structural-v4"


def observe(archive, entry, policy):
    item = entry.get_item()
    raw = decode_zim_html(item)
    allowed, reason, license = selection(raw, policy, entry.path)
    blocks = html_blocks(raw, REVISION)
    lead, lead_flags = article_lead(raw, 4096, REVISION, with_flags=True)
    body = "\n\n".join(block.text for block in blocks)
    return {"path": entry.path, "title": entry.title, "html_bytes": item.size, "blocks": len(blocks),
            "body_characters": len(body), "lead_characters": len(lead), "lead_excerpt": lead[:240],
            "body_text_sha256": hashlib.sha256(body.encode()).hexdigest(),
            "headings": [block.section for block in blocks if block.kind == "heading"][:8],
            "tables": sum(block.kind == "table" for block in blocks),
            "flags": sorted({flag for block in blocks for flag in block.flags}), "lead_flags": lead_flags,
            "selection": {"admitted": allowed, "reason": reason, "license": license}}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--archive", type=Path, required=True)
    parser.add_argument("--sha256", required=True, help="the archive's pinned SHA-256 the receipt binds")
    parser.add_argument("--selection-policy", choices=sorted(POLICIES), required=True)
    parser.add_argument("--scope", required=True, help="what the inspection covered and what it does not establish")
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--sample", type=int, default=12, help="entries drawn at random from the HTML entries")
    parser.add_argument("--path", action="append", default=[], help="an entry to observe besides the sample")
    parser.add_argument("--seed", type=int, default=0)
    arguments = parser.parse_args(argv)
    archive = Archive(str(arguments.archive))
    chosen = [archive.get_entry_by_path(path) for path in arguments.path]
    rng = random.Random(arguments.seed)
    attempts = 0
    while len(chosen) < len(arguments.path) + arguments.sample and attempts < 100 * max(1, arguments.sample):
        attempts += 1
        entry = archive._get_entry_by_id(rng.randrange(archive.entry_count))
        if not entry.is_redirect and html_type(entry.get_item().mimetype) and entry.path not in {e.path for e in chosen}:
            chosen.append(entry)
    counter = bytes(archive.get_metadata("Counter")).decode() if "Counter" in archive.metadata_keys else None
    receipt = {"source_sha256": arguments.sha256, "extraction_revision": REVISION,
               "selection_policy": arguments.selection_policy, "checked": True, "scope": arguments.scope,
               "archive": arguments.archive.name, "archive_uuid": str(archive.uuid), "archive_bytes": archive.filesize,
               "entry_count": archive.entry_count, "native_fulltext": archive.has_fulltext_index, "counter": counter,
               "sample_seed": arguments.seed,
               "observations": [observe(archive, entry, arguments.selection_policy) for entry in chosen]}
    arguments.output.write_text(json.dumps(receipt, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    for row in receipt["observations"]:
        print(f"{row['selection']['admitted']!s:5} blocks={row['blocks']:5} lead={row['lead_characters']:5} {row['path'][:70]}")


if __name__ == "__main__":
    main()
