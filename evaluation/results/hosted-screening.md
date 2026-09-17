# Hosted screening — September 2026

This exploratory, product-specific screen compared ten hosted model endpoints as Almanac's Pi chat and background agents. It informed which model to qualify locally first; it is not a general intelligence ranking or evidence of local admission.

The reported runs took place on **17 September 2026, 00:05–00:57 UTC**. All questions were development cases. The baseline used nine cases per model; follow-up research used five cases for five candidates after clarifying the production citation instruction. Four basic Bash cases were a separate, secondary signal for a future CLI. Bash is not a browser tool.

## Results

Product results count correct reviewed final outcomes; parentheses give the number of pristine runs. Research results count fully passed, reviewed cases, including source/citation checks. Bash reports exact artifacts separately from completed turns. `—` means not tested; `0/0` means no measured result, not zero competence. Exclusions count unmeasured cases across the displayed categories, not failed API requests.

| Exact model endpoint | Product correct/reviewed (pristine) | Clarified research passed/reviewed | Bash artifacts/measured | Bash finished/measured | Excluded: transport / evaluator |
|---|---:|---:|---:|---:|---:|
| `z-ai/glm-4.7-flash` | 8/8 (8) | 4/5 | 4/4 | 4/4 | 0 / 1 |
| `meta/muse-glimmer-30b` | 7/7 (6) | 4/4 | 4/4 | 3/4 | 3 / 0 |
| `qwen/qwen3.6-27b` | 5/9 (5) | 0/1 | 0/0 | 0/0 | 8 / 0 |
| `google/gemma-4-31b-it` | 4/9 (4) | — | — | — | 0 / 0 |
| `nvidia/nemotron-3-nano-30b-a3b` | 4/7 (4) | — | — | — | 2 / 0 |
| `google/gemma-4-26b-a4b-it` | 3/7 (3) | 2/4 | 4/4 | 4/4 | 0 / 0 |
| `mistralai/ministral-14b-2512` | 3/9 (3) | — | — | — | 0 / 0 |
| `qwen/qwen3.8-27b` | 3/4 (3) | 3/5 | 4/4 | 4/4 | 4 / 1 |
| `mistralai/mistral-small-3.2-24b-instruct` | 2/9 (2) | — | — | — | 0 / 0 |
| `ibm-granite/granite-4.2-8b` | 1/9 (1) | — | — | — | 0 / 0 |

The baseline has 78 agent-reviewed cases, two unresolved rubric judgments and ten transport/evaluator exclusions. Two Gemma 26B baseline judgments and one follow-up research judgment remain unadjudicated. Reviews were bound to exact receipts; they are not human-certified ground truth.

Muse repaired a rejected summary-tool call and stored the correct summary, so its correct-outcome count exceeds its pristine count. It also created all four correct Bash artifacts, but exceeded the six-completion limit while over-verifying one copy with unavailable utilities. GLM completed all four Bash tasks. An omitted synthetic audit-handoff record contaminated one GLM and one Qwen 3.8 baseline summary case; those are evaluator exclusions, not model failures.

Muse and GLM tie on the six baseline cases and four clarified-research cases both completed. Muse was selected for first local qualification based on observed source fidelity, with GLM retained as an alternative. GLM's additional altitude-conflict answer recognized inconsistent source units but supplied an inferred practical resolution. Muse's corresponding current-prompt case timed out, so this is not a completed head-to-head win on that question.

## Identities and settings

All runs used OpenRouter streaming Chat Completions through Pi, temperature `0`, `store:false`, usage reporting, required parameter support and no provider fallback within a request. Reasoning effort was `medium` except for the two Mistral endpoints, where it was omitted. Per-completion output limits were 4,096 tokens, or 8,192 for Granite; background-stage output limits were 16,384. Product/research cases allowed eight completions; Bash allowed six. A 65,536-byte serialized-input exposure bound and 180-second scenario deadline were experimental limits, not qualified native context budgets.

| Model | Baseline providers reported | Follow-up endpoint pins |
|---|---|---|
| Muse Glimmer 30B | Phala | `deepinfra/bf16` |
| Gemma 4 31B | CoreWeave, DeepInfra | — |
| Gemma 4 26B A4B | Darkbloom, NextBit | `cloudflare` |
| GLM-4.7-Flash | Venice | `cloudflare` rejected; `venice/fp8` retry |
| Nemotron 3 Nano 30B A3B | Crusoe | — |
| Ministral 3 14B | Mistral | — |
| Granite 4.2 8B | DeepInfra | — |
| Mistral Small 3.2 24B | DeepInfra | — |
| Qwen3.8 27B | DekaLLM, Parasail, Reka | `coreweave/fp8` |
| Qwen3.6 27B | DeepInfra, SiliconFlow | `alibaba` rejected; `deepinfra/fp8` retry |

The baseline was not provider-pinned across requests. Follow-up pins were explicit; privacy-policy rejections stayed unmeasured and the policy was not weakened. Endpoint tags are recorded identities, not independently verified weight/quantization hashes.

Provider effects were substantial. Median completed whole-case times for Muse/GLM were 14.31/24.58 seconds in the baseline and 150.62/31.10 seconds in pinned research. These include tool rounds and transport; they do not predict local speed.

## Evidence and limits

[Exported run, scenario, prompt, schema and receipt hashes](hosted-screening-identities.json) record the exact identities and requested settings. Public scenario sources are [source questions](../fixtures.json), [practical workflows](../workflows.json), [controlled references](../scenarios.json), [role cases](../roles.ts) and [shell cases](../shell/index.ts). The current suite has evolved since the baseline.

Raw requests, responses, retained source snapshots and detailed review receipts are not included in this publication. The hash export identifies those artifacts; it does **not** make this table fully independently reproducible from the public files alone. The [benchmark instructions](../README.md) explain how to produce new, separately identified runs.

The five table-contributing runs reported **$0.206080829** in API charges. The broader screening campaign, including earlier diagnostics and browser runs, reported **$0.391434525** across 686 distinct provider generation IDs. Interrupted or missing usage is not asserted free; conservative reserves were tracked separately.

This hosted screen admits no local configuration. Local quantization/parser behavior, native token counting, heldout cases, offline operation and the complete speech-plus-model resource envelope require separate evidence. Source disagreements, incomplete reading, citation errors and recovery behavior remain visible rather than being hidden in one composite score.
