"""Prepare/resume a compact archive in the active local reference-library union."""
import argparse
import asyncio
import json
from pathlib import Path

import httpx
from oracle_content.adapters import Embeddings, Qdrant
from oracle_content.extract import TokenCounter
from oracle_content.models import Document, Profile
from oracle_content.native import build_native, POLICIES
from oracle_content.store import Store


async def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--profile", type=Path, required=True)
    parser.add_argument("--data", type=Path, required=True)
    parser.add_argument("--archive", type=Path, required=True)
    parser.add_argument("--sha256", required=True)
    parser.add_argument("--pack-id", required=True)
    parser.add_argument("--title", required=True)
    parser.add_argument("--category", default="", help="Part of the library this archive is listed under, shared with the other archives of the same kind")
    parser.add_argument("--publisher", default="", help="Source attribution, distinct from the archive distributor")
    parser.add_argument("--source-base-url", required=True)
    parser.add_argument("--license", required=True)
    parser.add_argument("--selection-policy", choices=sorted(POLICIES), required=True)
    parser.add_argument("--inspection", type=Path, required=True, help="Representative source/structure inspection receipt")
    parser.add_argument("--content-state-reserve-bytes", type=int, required=True,
        help="Free-space floor on --data, which holds the original and this generation's article spans")
    parser.add_argument("--index-storage-reserve-bytes", type=int, required=True,
        help="Allocation ceiling on --index-storage; indexing stops once the vector store reaches it")
    # One number cannot stand for two quantities on two filesystems, and the figure
    # this flag used to carry was the index-storage one, so accepting it would apply a
    # vector-store ceiling as a content-state floor. Both replacements are reported
    # separately by the preparation report, so a caller already has them.
    parser.add_argument("--reserve-bytes", type=int, help=argparse.SUPPRESS)
    parser.add_argument("--index-storage", type=Path, required=True, help="Local Qdrant storage directory; allocated bytes are checked against its own reservation")
    parser.add_argument("--embed-url", required=True)
    parser.add_argument("--qdrant-url", required=True)
    parser.add_argument("--workers", type=int, default=1, help="Bounded native article extraction workers")
    parser.add_argument("--no-activate", action="store_true",
        help="Build and index without joining the active library; a later run without it joins")
    parser.add_argument("--bulk-encoder-command", type=Path, help="Optional argv JSON for an already qualified local JSONL encoder process")
    args = parser.parse_args()
    if args.reserve_bytes is not None:
        parser.error("--reserve-bytes named one number for two separate reservations on two "
                     "filesystems; pass --content-state-reserve-bytes (the content-state free-space "
                     "floor) and --index-storage-reserve-bytes (the vector-store allocation ceiling) "
                     "instead, using the footprint figures reported for each location")
    profile = Profile.model_validate_json(args.profile.read_text())
    token_path = Path(profile.encoder_tokenizer)
    if not token_path.is_absolute():
        token_path = args.profile.parent / token_path
    tokens = TokenCounter(str(token_path), profile.encoder_tokenizer_sha256)
    document = Document(document_id=args.pack_id, work_id=args.pack_id, pack_id=args.pack_id, title=args.title, publisher=args.publisher,
        language="en", source_url=args.source_base_url, sha256=args.sha256, media_type="application/x-zim",
        license=args.license, extraction_revision="html-structural-v4", original_path=str(args.archive.resolve()),
        rights_exceptions=["Original archive and media redistribution require their own source notices and exceptions review"])
    async with httpx.AsyncClient(timeout=profile.request_timeout, trust_env=False) as client:
        encoder = Embeddings(client, args.embed_url, profile, tokens)
        bulk = None
        try:
            if args.bulk_encoder_command:
                from bulk_encoder import ProcessEncoder
                bulk = ProcessEncoder(json.loads(args.bulk_encoder_command.read_text()), profile, tokens)
                await bulk.start()
                encoder = bulk
            dense = Qdrant(client, args.qdrant_url, encoder, profile)
            generation = await build_native(Store(args.data), document, profile, dense, token_path,
                selection_policy=args.selection_policy, inspection=args.inspection.read_text().strip(),
                content_state_reserve_bytes=args.content_state_reserve_bytes,
                index_storage=args.index_storage, index_storage_reserve_bytes=args.index_storage_reserve_bytes,
                workers=args.workers, category=args.category, activate=not args.no_activate)
            print(generation, flush=True)
        finally:
            if bulk is not None:
                await bulk.close()


if __name__ == "__main__":
    asyncio.run(main())
