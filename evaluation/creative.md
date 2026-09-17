# Conversation and creativity probe

`creative-cases.json` contains five development conversations: a greeting, short story, playful preference, two-turn correction and uncertain practical specification. Review the actual writing for specificity, coherence, conversational proportion and continuity. Persona keywords are not a creativity score. Fictional character expression is allowed; unsupported practical instructions and invented real user history remain separate factual concerns.

`creative-run.ts` compares two frozen copies of the production `oracle-prompts.ts` module through its exported `buildOraclePrompt`, the real Pi loop and product tools. Each arm starts fresh; turns within a case share conversation state. Order alternates across cases. Production sampling and output allowance are retained, with explicit completion/deadline experiment limits. Receipts preserve exact prompts, source hashes, requests, native token-count checks and answers. This is a single sampled comparison, not a statistical preference estimate or local release admission.

From the repository root, after coordinating access to an already running local candidate:

```bash
./node_modules/.bin/tsx evaluation/creative-run.ts --validate
./node_modules/.bin/tsx evaluation/creative-run.ts \
  --runtime /tmp/candidate.json --gateway http://127.0.0.1:18920/v1 \
  --baseline /tmp/baseline-oracle-prompts.ts \
  --revised /tmp/revised-oracle-prompts.ts --output /tmp/creative-comparison
./node_modules/.bin/tsx evaluation/test-creative.ts
```

Review every assistant text turn, source result and tool call, including intermediate text, rather than just the final `answer` field. Keep transport failures, truncation and incomplete trajectories separate from writing judgments. Record a rationale and supporting excerpt for each comparison; source fidelity cannot be offset by pleasing prose. The original stock manifest and case identities remain unchanged, and no speech playback or hosted API call is performed.

A focused follow-up can use `--prompt /tmp/current-oracle-prompts.ts` instead of the paired source flags, with `--cases creative.evening-greeting,creative.tuba-correction`. The selected case IDs and unchanged full-suite digest are recorded; use a fresh output directory so the earlier comparison remains intact.
