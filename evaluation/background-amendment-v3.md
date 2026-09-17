# Background contract amendment, version 3

This is the proposed corrected comparison after review of all three original background fixtures. It preserves the frozen main campaign and the earlier version 2 proposal. No original observations or scores are rewritten. `loadBackgroundSanityV3Cases()` supplies three separately identified cases, each ending in `-v3`.

## Production contracts

Typed input cannot establish a new voice utterance, transcription error, pronunciation hint or automatic replacement. Existing cleanup tools already operate on stored evidence: rejection requires a matching stored pair, correction requires an existing utterance identity, and both disable obsolete rules while preserving evidence. An explicit user statement may identify such a mistaken record in either input mode. The audit prompt now distinguishes this historical cleanup from detecting fresh voice errors. Tool evidence guards remain unchanged; the clarification does not authorize new rules or inferred corrections from typed wording.

`no_stem=true` disables Porter stemming and is already the default. Plural and punctuation normalization remain. The tool description, schema explanation, result text and graph comments now state this contract. The matcher is unchanged. A test demonstrates an achievable Porter repair (`running` no longer matching `run` after disabling previously enabled stemming), while `arms` continues to match `arm` before and after the same flag.

## Cases and observations

- Voice correction and stale description: retain the version 2 admitted production recall context and clarified handoff fields. Original recognition/logging wording is not retroactively strengthened.
- Explicit historical rejection: typed rejection may inspect and reject the stored bad pairing and disable its rule, preserving the deliberate title, alias and original utterance record. Fresh voice logging, pronunciation hints and automatic rules remain forbidden in this typed scenario.
- Glossary correction and unsupported plural distinction: retain actual admitted retrieval and prior audit evidence. Safe label/alias/description repairs remain assessable. The Arms request requires honest limitation disclosure and review flagging while preserving the named log; merely setting `no_stem` does not repair it. Receipts record real pre/post `Graph.termMatch` results for arm, arms, kiln, drying rack and glaze-shelf. Flags and metadata are not counted as successful retrieval repairs.

All original three-case comparative totals are confounded and unsuitable for clean model rankings. Their individual observed actions, errors and unchanged state remain diagnostic evidence. Version 3 is an independently frozen comparison, not a best-of retry or blanket forgiveness of unrelated model failures.

## Bounded execution proposal

Run three cases once across every original candidate: 30 trajectories, 16 completions and 180 seconds per trajectory, original sampling and candidate stage limits. Apply already approved routing corrections consistently. Freeze source, profiles, cases and rubrics only after root review. Wait for main and routing replay reservations to settle; acquire their same campaign owner and use their cumulative $50 ledger with distinct amendment identities. No independent allocation, model calls or execution freeze is part of preparation.
