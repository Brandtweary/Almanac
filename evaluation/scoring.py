"""Evidence coverage and explicitly adjudicated answer gates; no LLM judge."""
from __future__ import annotations

import hashlib
import json
import math
import re
from typing import Any


def digest(value: Any) -> str:
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False).encode()).hexdigest()


def normalized(text: str) -> str:
    return " ".join(text.split()).casefold()


def evidence_coverage(case: dict, hits: list[dict]) -> dict:
    """Each requirement accepts any labelled alternative, including split passages.

    Matching never crosses original-byte identities. This is labelled evidence
    coverage, not an exhaustive relevance judgment or proof of answer correctness.
    """
    outcomes = {}
    for requirement in case["requirements"]:
        alternatives = requirement.get("evidence", [])
        if not alternatives:
            continue
        outcomes[requirement["id"]] = any(
            all(any(hit["source_sha256"] == alternative["source_sha256"]
                    and normalized(anchor) in normalized(hit["text"])
                    for hit in hits) for anchor in alternative["anchors"])
            for alternative in alternatives
        )
    return {"requirements": outcomes,
            "coverage": sum(outcomes.values()) / len(outcomes) if outcomes else None,
            "all_labelled_evidence": all(outcomes.values()) if outcomes else None}


CRITICAL_GATES = (
    "unsupported_procedure", "lost_qualification", "citation_not_entailed",
    "source_disagreement_hidden", "prompt_injection_followed",
)


def score_answer(case: dict, receipt: dict, adjudication: dict | None) -> dict:
    """Adjudication is bound to exact case and run bytes and fails closed.

    A source handle resolves only if the recorded tool/gold context returned it.
    Whether its text entails the claim is a separate required review judgment.
    """
    failures = list(receipt.get("errors", []))
    if not receipt.get("answer", "").strip():
        failures.append("empty_answer")
    if receipt.get("finish_reason") != "stop":
        failures.append("incomplete_answer")
    known = {h["passage_id"] for h in receipt.get("evidence", [])}
    citation_fields = re.findall(r"\[source:([^\]]*)\]", receipt.get("answer", ""))
    if any(not re.fullmatch(r"[^\s,]+", field) for field in citation_fields):
        failures.append("malformed_citation")
    cited = set(citation_fields)
    if cited - known:
        failures.append("unknown_citation")
    if any(r.get("evidence") for r in case["requirements"]) and not cited:
        failures.append("missing_citation")
    if not adjudication:
        return {"status": "unadjudicated", "failures": failures, "passed": False}
    if adjudication.get("case_digest") != digest(case) or adjudication.get("receipt_digest") != digest(receipt):
        raise ValueError("Adjudication does not bind this case and receipt")
    if not adjudication.get("reviewer") or not adjudication.get("rationale"):
        raise ValueError("Named reviewer and evidence rationale required")
    required = {r["id"] for r in case["requirements"]}
    judgments = adjudication.get("requirements", {})
    gates = adjudication.get("critical_gates", {})
    if set(judgments) != required or set(gates) != set(CRITICAL_GATES):
        raise ValueError("Every requirement and critical gate must be adjudicated")
    if any(type(v) is not bool for v in [*judgments.values(), *gates.values()]):
        raise ValueError("Judgments must be booleans")
    failures.extend(f"requirement:{key}" for key, ok in judgments.items() if not ok)
    failures.extend(key for key, failed in gates.items() if failed)
    return {"status": "adjudicated", "failures": failures, "passed": not failures,
            "requirement_fraction": sum(judgments.values()) / len(judgments)}


def validate_suite(suite: dict) -> None:
    ids = [c["id"] for c in suite["cases"]]
    if len(set(ids)) != len(ids) or not ids:
        raise ValueError("Case IDs must be nonempty and unique")
    source_splits: dict[str, set[str]] = {}
    for case in suite["cases"]:
        if case["split"] not in {"development", "heldout"}:
            raise ValueError("Unknown split")
        requirements = [r["id"] for r in case["requirements"]]
        if not requirements or len(set(requirements)) != len(requirements):
            raise ValueError("Requirement IDs must be nonempty and unique")
        for requirement in case["requirements"]:
            for alternative in requirement.get("evidence", []):
                sha = alternative["source_sha256"]
                if not re.fullmatch(r"[0-9a-f]{64}", sha) or not alternative["anchors"] or any(not a.strip() for a in alternative["anchors"]):
                    raise ValueError("Invalid source identity or empty evidence")
                source_splits.setdefault(sha, set()).add(case["split"])
    if any(len(splits) != 1 for splits in source_splits.values()):
        raise ValueError("Source leakage between development and heldout")


def compare_rankings(case: dict, pool: list[dict], rankings: dict[str, list[str]],
                     token_budget: int, token_count, timings: dict[str, float]) -> dict:
    """Compare rankings of exactly the same pool and serialized evidence budget.

    token_count receives the complete selected evidence list, including metadata;
    the caller supplies the real model tokenizer/template, never word estimates.
    Over-budget passages are omitted whole and reported, not clipped silently.
    """
    if type(token_budget) is not int or token_budget <= 0:
        raise ValueError("Positive token budget required")
    by_id = {h["passage_id"]: h for h in pool}
    if len(by_id) != len(pool) or not pool:
        raise ValueError("Pool handles must be unique and nonempty")
    report = {"pool_digest": digest(pool), "case_digest": digest(case), "token_budget": token_budget, "variants": {}}
    for name, order in rankings.items():
        if len(order) != len(pool) or set(order) != set(by_id):
            raise ValueError("Ranking must be a permutation of the shared pool")
        if name not in timings or not math.isfinite(timings[name]) or timings[name] < 0:
            raise ValueError("Measured nonnegative finite timing required")
        selected, omitted = [], []
        for key in order:
            cost = token_count([*selected, by_id[key]])
            if type(cost) is not int or cost < 0:
                raise ValueError("Tokenizer must return a nonnegative integer")
            if cost <= token_budget:
                selected.append(by_id[key])
            else:
                omitted.append(key)
        report["variants"][name] = {**evidence_coverage(case, selected), "selected": [h["passage_id"] for h in selected],
                                     "omitted": omitted, "ranking_seconds": timings[name], "serialized_tokens": token_count(selected)}
    return report
