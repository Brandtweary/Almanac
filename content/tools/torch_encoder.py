"""Offline BERT mean-pooling worker; run in a pinned torch/transformers environment."""
import argparse
import base64
import hashlib
import json
from pathlib import Path
import sys
import time


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model", type=Path, required=True)
    parser.add_argument("--model-id", required=True)
    parser.add_argument("--revision", required=True)
    parser.add_argument("--weights-sha256", required=True)
    parser.add_argument("--max-tokens", type=int, required=True)
    parser.add_argument("--batch", type=int, default=256)
    args = parser.parse_args()
    weights = args.model / "model.safetensors"
    with weights.open("rb") as stream:
        if hashlib.file_digest(stream, "sha256").hexdigest() != args.weights_sha256:
            raise ValueError("Bulk encoder weights failed integrity validation")
    import torch
    from transformers import AutoModel, AutoTokenizer
    torch.set_num_threads(2)
    tokenizer = AutoTokenizer.from_pretrained(args.model, local_files_only=True)
    model = AutoModel.from_pretrained(args.model, local_files_only=True).to("cuda").eval()
    if model.config.model_type != "bert":
        raise ValueError("This worker's validated pooling contract requires BERT mean pooling")
    identity = {"model_id": args.model_id, "revision": args.revision,
        "tokenizer_sha256": hashlib.sha256((args.model / "tokenizer.json").read_bytes()).hexdigest(),
        "weights_sha256": args.weights_sha256, "dimensions": model.config.hidden_size,
        "pooling": "attention-masked mean, L2 normalized", "dtype": str(next(model.parameters()).dtype),
        "input_contract": {"max_tokens": args.max_tokens, "overflow": "reject"},
        "vector_transport": "float32-le-base64-v1"}
    print(json.dumps(identity), flush=True)
    for line in sys.stdin:
        try:
            started = time.perf_counter()
            texts = json.loads(line)["texts"]
            if not isinstance(texts, list) or not texts or len(texts) > args.batch or any(not isinstance(text, str) for text in texts):
                raise ValueError("Invalid bounded text batch")
            inputs = tokenizer(texts, padding=True, truncation=False, return_tensors="pt")
            if inputs["input_ids"].shape[1] > args.max_tokens:
                raise ValueError("Input exceeds declared encoder window")
            inputs = inputs.to("cuda")
            tokenized = time.perf_counter()
            with torch.inference_mode():
                hidden = model(**inputs).last_hidden_state
                mask = inputs["attention_mask"].unsqueeze(-1).expand(hidden.size()).float()
                pooled = (hidden * mask).sum(1) / mask.sum(1).clamp(min=1e-9)
                vectors = torch.nn.functional.normalize(pooled, p=2, dim=1).cpu().numpy()
            computed = time.perf_counter()
            encoded = base64.b64encode(vectors.astype("<f4", copy=False).tobytes()).decode("ascii")
            serialized = time.perf_counter()
            timings = {"tokenize_seconds": tokenized - started, "forward_and_copy_seconds": computed - tokenized,
                       "serialization_seconds": serialized - computed, "articles": len(texts)}
            print(json.dumps({"embeddings_base64": encoded, "timings": timings}), flush=True)
        except Exception as error:
            print(json.dumps({"error": f"{type(error).__name__}: {error}"}), flush=True)


if __name__ == "__main__":
    main()
