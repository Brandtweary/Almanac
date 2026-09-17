"""Measure a verified archive before admitting full corpus indexing."""
from __future__ import annotations
import argparse
import asyncio
import json
from pathlib import Path
import time

import httpx
from oracle_content.adapters import Embeddings
from oracle_content.capacity import measure_documents, zim_sample
from oracle_content.extract import TokenCounter
from oracle_content.models import Document, Profile
from oracle_content.store import atomic_json


async def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--document", type=Path, required=True, help="Verified source Document JSON")
    parser.add_argument("--profile", type=Path, required=True)
    parser.add_argument("--samples", type=int, required=True)
    parser.add_argument("--seed", type=int, default=0)
    parser.add_argument("--scratch", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--embed-url", help="Optional pinned embedding throughput measurement; never chat inference")
    args = parser.parse_args()
    document = Document.model_validate_json(args.document.read_text())
    profile = Profile.model_validate_json(args.profile.read_text())
    tokenizer_path = Path(profile.encoder_tokenizer)
    if not tokenizer_path.is_absolute():
        tokenizer_path = args.profile.parent / tokenizer_path
    tokenizer = TokenCounter(str(tokenizer_path), profile.encoder_tokenizer_sha256)
    documents, archive = zim_sample(document, args.samples, args.seed)
    report, inputs = measure_documents(documents, profile, tokenizer, archive["entry_count"], args.scratch)
    report["archive"] = archive
    report["source_identity"] = {"sha256": document.sha256, "extraction_revision": document.extraction_revision,
                                "work_id": document.work_id}
    atomic_json(args.output, report)
    if args.embed_url and inputs:
        async with httpx.AsyncClient(timeout=profile.request_timeout, trust_env=False) as client:
            encoder = Embeddings(client, args.embed_url, profile, tokenizer)
            await encoder.encode(inputs[:1])
            started = time.perf_counter()
            for offset in range(0, len(inputs), profile.embedding_batch):
                await encoder.encode(inputs[offset:offset + profile.embedding_batch])
            elapsed = time.perf_counter() - started
            report["embedding"] = {"sample_passages": len(inputs), "seconds": elapsed,
                "passages_per_second": len(inputs) / elapsed,
                "embedding_seconds_extrapolated": report["metrics"]["passages"]["estimate"] * elapsed / len(inputs),
                "input_tokens": sum(tokenizer.count(text) for text in inputs),
                "caveat": "Serial pinned-service sample, excluding Qdrant insertion, validation and optimizer time."}
            atomic_json(args.output, report)
    print(json.dumps({"output": str(args.output), "estimable": report["estimable"], "storage": report["storage"],
                      "embedding": report.get("embedding")}, indent=2))


if __name__ == "__main__":
    asyncio.run(main())
