"""Explicit developer measurement of a shared candidate pool; never a runtime fallback."""
from __future__ import annotations
import argparse
import asyncio
import json
import os
from pathlib import Path
import sys
import time
import uuid
import httpx
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from evaluation.scoring import compare_rankings, evidence_coverage, digest
from evaluation.ranking import cross_encoder_order, mmr_order
from oracle_content.app import configured_service
from oracle_content.adapters import Reranker, vectors_valid
from oracle_content.extract import TokenCounter
from oracle_content.store import atomic_json


async def measure(args):
    suites = [json.loads(path.read_text()) for path in args.suite]
    cases = [c for suite in suites for c in suite["cases"] if c["split"] == "development"]
    if len({c["id"] for c in cases}) != len(cases):
        raise ValueError("duplicate development case IDs")
    labels = json.loads(args.structural_labels.read_text()) if args.structural_labels else None
    if labels and set(labels["parent_suite_digests"]) != {digest(suite) for suite in suites}:
        raise ValueError("structural label parent digests mismatch")
    structural = {c["id"]: c for c in labels["cases"]} if labels else {}
    args.output.mkdir(parents=True, exist_ok=False)
    async with httpx.AsyncClient(timeout=120, trust_env=False) as client:
        service = configured_service(client)
        p = service.profile
        if p.qualified:
            raise ValueError("development measurement must use an explicitly unqualified profile")
        tokenizer_path = Path(p.reranker_tokenizer)
        if not tokenizer_path.is_absolute():
            tokenizer_path = Path(os.environ["CONTENT_PROFILE"]).resolve().parent / tokenizer_path
        reranker = Reranker(client, os.environ["CONTENT_RERANK_URL"], p,
                            TokenCounter(str(tokenizer_path), p.reranker_tokenizer_sha256))
        generation = service.active()
        manifest = service.store.manifest(generation)
        heldout = {e["source_sha256"] for suite in suites for case in suite["cases"] if case["split"] == "heldout"
                   for r in case["requirements"] for e in r.get("evidence", [])}
        with service.store.connect(generation) as db:
            sources = {json.loads(row[0])["sha256"] for row in db.execute("SELECT data FROM documents")}
        if sources & heldout:
            raise ValueError("heldout source is present in the development index")
        report = {"generation": generation, "profile_id": p.profile_id, "profile_fingerprint": p.fingerprint,
            "index_fingerprint": p.index_fingerprint, "manifest": manifest,
            "suite_digests": [digest(s) for s in suites], "label_digest": digest(labels) if labels else None,
            "tokenizer_sha256": p.chat_tokenizer_sha256,
            "token_budget_scope": "serialized returned evidence under the configured diagnostic tokenizer; not a selected chat-model budget",
            "timing_scope": "retrieval through HTTP plus incremental ranking/vector-fetch compute; warm service, first and repeat query recorded separately",
            "mmr_weights": args.mmr_weight, "cases": []}
        for case in cases:
            begin = time.perf_counter()
            candidates = await service.candidates(case["question"])
            first_seconds = time.perf_counter() - begin
            begin = time.perf_counter()
            repeated = await service.candidates(case["question"])
            retrieval_seconds = time.perf_counter() - begin
            if candidates["degradation"] or repeated["degradation"]:
                raise ValueError("degraded candidates cannot be used as an ordinary hybrid measurement")
            rows, passages = candidates["rows"], candidates["passages"]
            pool = []
            for row in rows:
                passage = passages[row["passage_id"]]
                hit = service.hit(generation, passage)
                pool.append({**hit, "source_sha256": passage.source_revision, "text": passage.text})
            if not pool:
                raise ValueError("empty pool requires source/retrieval diagnosis before ranking")
            begin = time.perf_counter()
            scores = await reranker.rank(case["question"], [passages[h["passage_id"]] for h in pool])
            ce_seconds = time.perf_counter() - begin
            ce_order = cross_encoder_order(pool, list(scores.items()))
            orders = {"fusion": [r["passage_id"] for r in rows], "cross_encoder": ce_order}
            timings = {"fusion": retrieval_seconds, "cross_encoder": retrieval_seconds + ce_seconds}
            begin = time.perf_counter()
            response = await client.post(service.dense.collection(generation) + "/points", json={
                "ids": [str(uuid.uuid5(uuid.NAMESPACE_URL, h["passage_id"])) for h in pool],
                "with_payload": True, "with_vector": True})
            response.raise_for_status()
            vectors = {}
            for point in response.json()["result"]:
                payload = point["payload"]
                if payload.get("generation") != generation or payload.get("encoder") != p.index_fingerprint:
                    raise ValueError("MMR vector identity mismatch")
                vectors_valid([point["vector"]], 1, p.encoder_dimensions)
                vectors[payload["passage_id"]] = point["vector"]
            fetch_seconds = time.perf_counter() - begin
            for weight in args.mmr_weight:
                begin = time.perf_counter()
                name = f"mmr_{weight:g}"
                orders[name] = mmr_order(ce_order, vectors, relevance_weight=weight)
                timings[name] = retrieval_seconds + ce_seconds + fetch_seconds + time.perf_counter() - begin
            token_cache = {}
            def count(hits):
                key = tuple(h["passage_id"] for h in hits)
                if key not in token_cache:
                    # Scoring aliases are not serialized twice into the actual tool response.
                    wire = [{k: v for k, v in h.items() if k not in {"text", "source_sha256"}} for h in hits]
                    token_cache[key] = service.tokenizer.count(json.dumps(wire, ensure_ascii=False, separators=(",", ":")))
                return token_cache[key]
            evidence_rows = [{**h} for h in pool]
            result = {"case_id": case["id"], "query": case["question"], "pool": pool,
                "branch_ids": {key: [pid for pid, _ in value] for key, value in candidates["branches"].items()},
                "pool_coverage_original": evidence_coverage(case, evidence_rows),
                "pool_coverage_structural": evidence_coverage(structural.get(case["id"], case), evidence_rows),
                "first_query_seconds": first_seconds, "repeat_query_seconds": retrieval_seconds,
                "cross_encoder_seconds": ce_seconds, "mmr_vector_fetch_seconds": fetch_seconds,
                "rankings": orders, "scores": scores, "comparisons": []}
            for budget in args.budget:
                started = time.perf_counter()
                original = compare_rankings(case, pool, orders, budget, count, timings)
                structural_result = compare_rankings(structural.get(case["id"], case), pool, orders, budget, count, timings)
                result["comparisons"].append({"token_budget": budget, "original": original,
                    "structural": structural_result, "comparison_packing_seconds": time.perf_counter() - started})
            report["cases"].append(result)
            atomic_json(args.output / "results.json", report)
            print(json.dumps({"case": case["id"], "pool": len(pool), "retrieval_seconds": retrieval_seconds,
                              "rerank_seconds": ce_seconds, "coverage": result["pool_coverage_structural"]}), flush=True)
        atomic_json(args.output / "results.json", report)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--suite", type=Path, action="append", required=True)
    parser.add_argument("--structural-labels", type=Path)
    parser.add_argument("--budget", type=int, action="append", required=True)
    parser.add_argument("--mmr-weight", type=float, action="append", required=True)
    parser.add_argument("--output", type=Path, required=True)
    asyncio.run(measure(parser.parse_args()))
