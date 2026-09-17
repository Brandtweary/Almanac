"""Create an unqualified local corpus profile from installed tokenizer/backend identities."""
import argparse
import asyncio
import hashlib
from pathlib import Path

import httpx
from oracle_content.models import Profile
from oracle_content.store import atomic_json


async def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--id", required=True)
    parser.add_argument("--encoder-tokenizer", type=Path, required=True)
    parser.add_argument("--chat-tokenizer", type=Path, required=True)
    parser.add_argument("--embed-url", required=True)
    parser.add_argument("--encoder-id", help="Portable model ID when backend /info names a mounted directory")
    parser.add_argument("--response-tokens", type=int, required=True)
    parser.add_argument("--read-tokens", type=int, required=True)
    parser.add_argument("--vector-datatype", choices=["float32", "float16"], required=True)
    args = parser.parse_args()
    async with httpx.AsyncClient(timeout=30, trust_env=False) as client:
        response = await client.get(args.embed_url.rstrip("/") + "/info")
        response.raise_for_status()
        info = response.json()
        import re
        if not re.fullmatch(r"[a-f0-9]{40}", info.get("model_sha", "")):
            raise ValueError("Embedding backend must expose its pinned revision")
        response = await client.post(args.embed_url.rstrip("/") + "/embed", json={"inputs": ["Corpus profile identity measurement"], "truncate": False})
        response.raise_for_status()
        dimension = len(response.json()[0])
    output = args.output.resolve()
    def relative(path):
        import os
        return os.path.relpath(path.resolve(), output.parent)
    profile = Profile(profile_id=args.id, qualified=False, encoder_id=args.encoder_id or info["model_id"],
        encoder_runtime_id=info["model_id"], encoder_revision=info["model_sha"], encoder_dimensions=dimension,
        encoder_tokenizer=relative(args.encoder_tokenizer), encoder_tokenizer_sha256=hashlib.sha256(args.encoder_tokenizer.read_bytes()).hexdigest(),
        encoder_max_tokens=info["max_input_length"], chat_tokenizer=relative(args.chat_tokenizer),
        chat_tokenizer_sha256=hashlib.sha256(args.chat_tokenizer.read_bytes()).hexdigest(),
        lexical_depth=40, dense_depth=40, rrf_k=60, lexical_weight=1, dense_weight=1, page_size=12,
        response_tokens=args.response_tokens, read_tokens=args.read_tokens, query_max_chars=2000,
        request_timeout=60, embedding_batch=min(32, info["max_client_batch_size"]), vector_datatype=args.vector_datatype)
    atomic_json(output, profile.model_dump())
    print(f"Wrote {output}; profile remains unqualified until retrieval admission receipts exist")


if __name__ == "__main__":
    asyncio.run(main())
