# Local stock qualification

`local-stock-run.ts` runs the existing stock cases, production prompts, Pi tools and rubrics through the production local tokenizer, admission queue and streaming transport. Source fixtures remain synthetic benchmark evidence; these results do not qualify production retrieval, whole-stack speech overlap or release installation. No command starts or downloads a model. Candidate profiles remain explicitly `qualified:false`.

Pin a complete runtime descriptor with model file hashes, tokenizer/template hashes and immutable serving image/source identities. The selected Muse configuration has [recorded local runtime and bounded quality measurements](../results/local-runtime.md); the other candidate descriptors remain acquisition plans. The gateway's model/tokenizer/template identity must match that descriptor; container inspection and artifact verification must independently establish that the deployed bytes match the declared identity.

Prepare explicit experiment budgets, then start a dedicated loopback gateway against an already-running local inference service. Check both ports before binding. An SSH loopback forward may supply the inference origin; existing speech services remain separate.

```bash
./node_modules/.bin/tsx evaluation/local-stock-run.ts \
  --runtime deploy/muse-glimmer-vllm-candidate.json \
  --prepare-profile /tmp/muse-candidate-profile.json \
  --context 131072 --output-tokens 2048 --stage-output-tokens 16384
bun proxy/qualification.ts --profile /tmp/muse-candidate-profile.json \
  --inference http://127.0.0.1:18910 --port 18920 --log /tmp/muse-gateway.jsonl
```

These bounds describe the measured single-RTX5090 candidate with BF16 KV and CPU PocketTTS; they remain candidate parameters rather than universal machine defaults. A descriptor may supply model-specific sampling settings; the generated profile enforces those settings before token counting and generation in both client and gateway. The profile's input allowance is context minus reserved output. Derive any context increase from observed tokenizer counts and runtime/speech allocations. The qualification gateway uses a synthetic capability declaration solely to exercise stock scenarios; it exposes no production corpus or memory data.

Count the initial prompts, fixture evidence and complete tool schemas before generating answers. This path calls the actual model tokenizer through the gateway and stops before completion admission. Every selected role receives a measurement-only receipt; a count over its input allowance remains visible.

```bash
./node_modules/.bin/tsx evaluation/local-stock-run.ts \
  --runtime deploy/muse-glimmer-vllm-candidate.json \
  --gateway http://127.0.0.1:18920/v1 --measure-only \
  --output /tmp/muse-initial-counts
```

After checking these counts and native tokenizer/inference parity, run the unchanged development smoke or select frozen cases explicitly:

```bash
./node_modules/.bin/tsx evaluation/local-stock-run.ts \
  --runtime deploy/muse-glimmer-vllm-candidate.json \
  --gateway http://127.0.0.1:18920/v1 --smoke \
  --max-completions 8 --timeout-ms 180000 --output /tmp/muse-local-smoke
```

`--validate` lists selection without network access. Default selection is the development agent track; `--split heldout` explicitly selects untouched heldout cases, and `--track shell` selects the existing isolated shell cases. `--cases` accepts exact comma-separated IDs. Missing OS containment refuses shell work. Keep heldout exposure until candidate settings are frozen. No case wording or rubric is rewritten by this adapter.

Generated profile IDs fingerprint the candidate configuration and role limits, including cache and sampling settings. Every output directory must be fresh. `freeze.json` binds source snapshots, suite/case identities, model/image/template descriptors, actual gateway profile and work limits. Per-case receipts preserve native tokenizer requests/results, generation requests, raw SSE, native usage, final state, tool calls and unchanged rubrics. Native usage must match the count of the same normalized request; a mismatch is an evaluator failure. Failed transport and missing usage remain explicit, and local API cost zero does not estimate electricity or hardware cost. Semantic outcomes remain unadjudicated until the existing `adjudicate.py` workflow reviews them. Measurement-only runs contain no quality verdict.

Offline regression checks:

```bash
./node_modules/.bin/tsx --test evaluation/test-local-stock.ts scripts/test-runtime-sampling.ts
./node_modules/.bin/tsc -p evaluation/tsconfig.json
```
