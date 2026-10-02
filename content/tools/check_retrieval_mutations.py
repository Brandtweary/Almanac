#!/usr/bin/env python3
"""Prove the offline sanity check rejects historical failures, without editing files.

Run with the content test environment: python tools/check_retrieval_mutations.py
Each mutation lives in one child interpreter; the final control uses clean code.
"""
from pathlib import Path
import subprocess
import sys
import tempfile
import textwrap
import xml.etree.ElementTree as ET


ROOT = Path(__file__).resolve().parents[1]
CHECKS = "tests/test_retrieval_sanity.py"
MUTATIONS = {
    "generation-rank-fusion": (
        CHECKS + "::test_every_collection_can_supply_the_first_answer",
        '''
        import oracle_content.service as service
        def rank_only(pools, k):
            return {branch: [(row["passage_id"], row["score"]) for row in service.fuse(
                {str(i): pool["branches"][branch] for i, pool in enumerate(pools)},
                {str(i): 1 for i in range(len(pools))}, k)]
                for branch in ("lexical", "dense")}
        service.merge_branches = rank_only
        ''',
    ),
    "silent-dense-loss": (
        CHECKS + "::test_each_arm_contributes_an_answer_the_other_misses",
        '''
        from oracle_content.adapters import Qdrant
        async def empty(self, generation, query, document_id=None):
            return []
        Qdrant.search = empty
        ''',
    ),
    "silent-lexical-loss": (
        CHECKS + "::test_each_arm_contributes_an_answer_the_other_misses",
        '''
        from oracle_content.service import Service
        async def empty(self, generation, query, document_id):
            return []
        Service.lexical = empty
        ''',
    ),
    "chat-tokenizer-for-encoder": (
        CHECKS + "::test_long_query_keeps_semantic_answer_with_distinct_tokenizers",
        '''
        from oracle_content.service import Service
        fit = Service.fit_dense_query
        def wrong_counter(self, query):
            encoder = self.encoder_tokenizer
            self.encoder_tokenizer = self.tokenizer
            try:
                return fit(self, query)
            finally:
                self.encoder_tokenizer = encoder
        Service.fit_dense_query = wrong_counter
        ''',
    ),
}


def check(label, selection, mutation, expect_failure, directory):
    report = directory / (label + ".xml")
    code = textwrap.dedent(mutation) + "\nimport pytest, sys\nraise SystemExit(pytest.main(sys.argv[1:]))\n"
    result = subprocess.run([sys.executable, "-c", code, "-q", selection, "--junitxml", str(report)],
                            cwd=ROOT, text=True, capture_output=True)
    print(f"\n{label}:\n{result.stdout}", flush=True)
    if result.stderr:
        print(result.stderr, file=sys.stderr)
    if not report.exists():
        raise SystemExit(f"{label}: missing test receipt (exit {result.returncode})")
    cases = ET.parse(report).findall(".//testcase")
    failures = sum(case.find("failure") is not None for case in cases)
    errors = sum(case.find("error") is not None for case in cases)
    skipped = sum(case.find("skipped") is not None for case in cases)
    # Collection/import failures must never count as detecting a retrieval bug.
    valid = bool(cases) and not errors and not skipped
    valid &= (result.returncode == 1 and failures == len(cases)) if expect_failure else (
        result.returncode == 0 and failures == 0)
    if not valid:
        raise SystemExit(f"{label}: unexpected result: {len(cases)} cases, {failures} failures, {errors} errors")


def main():
    with tempfile.TemporaryDirectory(prefix="retrieval-mutations-") as directory:
        directory = Path(directory)
        check("baseline", CHECKS, "", False, directory)
        for label, (selection, mutation) in MUTATIONS.items():
            check(label, selection, mutation, True, directory)
        check("restored", CHECKS, "", False, directory)
    print("Historical and silent-arm mutations were rejected; clean sanity checks pass. No source files changed.")


if __name__ == "__main__":
    main()
