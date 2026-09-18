# Almanac stock benchmark

[Full hosted campaign and follow-up review](results/full-campaign-20260917.md) reports the completed ten-candidate study with separate research, character, memory and Bash results; the [initial hosted screen](results/hosted-screening.md) retains its earlier scope.

The separate [conversation and creativity probe](creative.md) compares two frozen production personas on five qualitative development conversations; it does not alter the 49 stock scenarios or their factual scores.

`campaign-run.ts` runs the combined 49 stock, five creative and three supplemental audit scenarios across ten explicitly pinned hosted candidates. It freezes sources, cases, sampling and previously exposed holdout labels; a durable budget ledger retains interrupted-request exposure and includes prior charges/reserves in the cumulative ceiling. Its required `--prior-budget` JSON contains `ceilingUSD`, `priorReportedUSD` and `priorUnknownReserveUSD`; `--prepare` freezes without inference, and `--resume` requires unchanged identities. Supply `--profiles`, a fresh `--output`, and the developer-only key for actual calls. Report categories separately; isolated role probes do not certify integrated pipeline publication.

Semantic reviews may record `additionalFindings` with a kind and evidence alongside frozen rubric judgments; targeted-check success is not a clean-answer endorsement when ancillary arithmetic, factual or assurance errors remain.

The stock suite compares a candidate as Almanac's actual Pi chat/background agent. A deterministic driver operates the application; the candidate is not a separate browser-automation agent. The versioned manifest is `benchmark.json`: 41 agent scenarios (30 development, 11 heldout), eight isolated-shell scenarios (four development, four heldout), a four-case real-browser subset, and 29 deterministic publication/recovery/context/maintenance contracts. Browser cases and mechanical contracts are separate from model-quality scores.

Bash is a separate, operator-selected secondary signal of general instruction-following, not a browser capability, a shipped application capability or a coding benchmark. `--track shell` uses only generated files and an OS namespace jail; absent containment refuses the track. No host home, workspace, credentials or network are exposed. Shell results use actual exit/output/artifact checks and do not offset research failures.

The fixed nine-case smoke subset gives a quick comparison across source lookup, cross-section warnings, conflicting editions, untrusted reference instructions, personal-fact/proposal provenance, typed speech handling, summary and compaction. It uses the shared production persona, tool schemas, Pi loop, Markdown `corpus:` citations, and explicit background stage outcomes. A promising candidate can then run the complete development suite and frozen heldout cases. No model wins merely because a run completed.

From the repository root, with a developer-only `OPENROUTER_API_KEY` already in the environment:

```bash
./node_modules/.bin/tsx evaluation/benchmark-run.ts --validate
./node_modules/.bin/tsx evaluation/benchmark-run.ts \
  --profiles /tmp/pinned-candidates.json --output /tmp/almanac-smoke \
  --max-spend 5 --prior-budget /tmp/prior-budget.json --smoke
./node_modules/.bin/tsx evaluation/benchmark-run.ts \
  --contracts --output /tmp/almanac-contracts
python3 evaluation/adjudicate.py /tmp/almanac-smoke \
  --template --output /tmp/almanac-review.json
```

Review the raw answers, returned sources, tool trace and final memory state; fill the template with an identified reviewer, one judgment per frozen rubric clause, and evidence-based reasons. Then generate the readable comparison:

```bash
python3 evaluation/adjudicate.py /tmp/almanac-smoke \
  --reviews /tmp/almanac-review.json --output /tmp/almanac-ranking.json
```

The companion Markdown table distinguishes workflow checks, semantic review, critical failures, transport errors, latency and spend. Missing semantic review stays unadjudicated. API refusals/rate limits are transport failures; bad source units or attribution are answer failures; missing explicit stage outcomes and unknown source handles are protocol failures. Tentative personal facts may be retained as tentative: an `add_term` call alone does not establish false provenance.

The legacy stock runner also requires `--prior-budget`; direct paid browser runs require `--prior-budget=PATH` with the same cumulative-budget schema and full `prices`/`providerRouting` in the candidate profile. Each run pins case/profile/source/schema identities, copies a source snapshot including its ESM package manifest and lockfile and keeps exact requests, responses and per-case receipts. A fresh directory is required; `--resume` accepts only an unchanged suite, source, profile and limits. Experiment output budgets, reasoning settings, request limits and conservative input-byte exposure bounds are explicit profile choices, not qualified production tokenizer budgets. Unknown billing retains a conservative reserve instead of silently counting as free. Candidate catalogs/prices must be refreshed before a later model comparison; `candidates.json` records its observation date.

`benchmark-run.ts --browser` accepts a single candidate profile and runs the real-browser subset through the same entry point; `browser.ts` also exports `runBrowserSubset`. [Local qualification](local.md) uses the same cases through the production gateway and native token counter; measure-only admission performs no generation. The browser subset uses the real built UI with isolated browser storage and a loopback development bridge. The bridge keeps credentials server-side and reuses the production queue and controlled library adapter. It never becomes a product cloud fallback. A built application and Playwright Chromium are required. The controlled library deliberately identifies itself as an unqualified fixture; it tests agent research workflow, not real-index retrieval quality.

## Source and ranking diagnostics

This developer package separates retrieval coverage, reading supplied gold evidence, and full tool-driven research. It does not select a production model, claim benchmark leadership, or qualify the complete application.

`fixtures.json` freezes six EPA development questions and six source-disjoint FEMA heldout questions. `workflows.json` adds six development questions about composting, microhydro, solar power, soil, rain collection and biosand-filter sequencing. Previously scored questions remain development material. The small heldout set measures a narrow generalization boundary; public availability means it is not a secret benchmark and it must not become training data.

The fixture source hashes refer to original downloaded bytes. Excerpts are manually checked text spans, with alternatives where inspected. The FEMA source has two-column pages: layout-preserving plain text can interleave columns, so source order must be verified against the PDF. The EPA altitude parenthesis contains inconsistent units; its fixture requires reporting that inconsistency rather than treating a reference as infallible. These are retrieval/reading fixtures, not current public safety advice.

`scoring.py` measures labelled evidence coverage against original-byte identity. It does not call an anchor miss proof of irrelevance: further valid passages require an explicit adjudication and versioned labels. Answer scoring requires an identified reviewer, rationale, every requirement and critical gate, and digests binding the exact fixture and receipt. Missing review never passes. Invalid citations, unsupported critical procedures, missing consequential qualifications and hidden source disagreements cannot be averaged away.

The earlier `[source:HANDLE]` prompt/HTTP runs are diagnostic experiments, distinct from the stock production prompt and `corpus:` protocol. `research.py` executes a provider-independent, bounded search/read loop or a separate gold-context pass. Transports are supplied callbacks; no API is contacted implicitly. Truncated tool calls never execute, an entire tool batch validates before execution, tool IDs remain paired, and reasoning fields survive round trips. `roles.ts` supplies synthetic role cases; `stock.ts` assembles the current production role tools and executes Pi with isolated synthetic memory. Its receipts still require semantic review; passing mocked tests does not establish model competence or storage durability.

`compare_rankings` requires all ranking arms to reorder exactly one shared pool under the same serialized token budget. Supply the actual tokenizer/template counter. It omits whole over-budget passages and reports them. `ranking.py` validates cross-encoder cardinality and scores and provides an explicit rank-percentile/cosine MMR comparison arm. The scale transform is defined but its weight is not empirically qualified. Freeze any development-selected weight before heldout use. Neither a reranker nor novelty selection is presumed better than fusion.

Run deterministic checks from the repository root:

```bash
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest evaluation.test_evaluation
./node_modules/.bin/tsx evaluation/test-stock.ts
./node_modules/.bin/tsc -p evaluation/tsconfig.json
./node_modules/.bin/tsx evaluation/export-memory.ts /tmp/role-schemas.json
```


Release admission also needs corpus coverage beyond these seeds, actual retrieval/reranker measurements, tool-led research, retained-role runs, target quantization/parser checks, offline installation and measured speech/LLM overlap. Infrastructure fault tests belong to the application/content suites; these evaluator tests are not their substitute.

## Source permissions

EPA and FEMA fixtures contain text-only US federal agency excerpts with source URLs and original-byte hashes; no logos, photographs or third-party illustrations are included. The excerpts in `workflows.json` are by Appropedia contributors and remain under [CC BY-SA 3.0](https://creativecommons.org/licenses/by-sa/3.0/), separately from the code license. Each excerpt identifies its source page, whose history supplies contributor attribution; changes are whitespace normalization and excerpt selection. The surrounding questions, scoring code and original annotations follow the repository license. No source-document rights are inferred from the application's MIT license.

One combined leaderboard retains separate product, research and secondary shell categories, with targeted-rubric passes, explicitly clean answers and additional findings counted separately:

```bash
python3 -m evaluation.leaderboard --product /tmp/product-run \
  --research /tmp/research-run --shell /tmp/shell-run \
  --output /tmp/almanac-comparison.json
```

Repeated `--research` or `--shell` directories may replace only earlier unmeasured transport/evaluator attempts with the same case identity. Measured repetitions cannot be silently cherry-picked. `--compare` restricts the reported common-case intersection to a named contender group while retaining the full table.
