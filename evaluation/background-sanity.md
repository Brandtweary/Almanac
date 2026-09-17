# Background operation sanity checks

`loadBackgroundSanityCases()` adds three synthetic development audit cases to a comparison campaign. It does not change the canonical 49-case stock inventory. Cases and rubrics are frozen before comparing candidates; these are operation checks, not additional heldout evidence.

The cases cover a supported speech correction with exact-source handoff, rejection of an erroneous historical speech rule while preserving an intentional alias, and glossary corrections with independent prior-action evidence. They use production prompts, mutation tools, outcome validation and the same dictionary asset as the browser. Synthetic speech, aliases and prior actions are explicit fixture seeds. Native eSpeak pronunciation responses are frozen for identical hints across candidates. An unknown pronunciation span fails explicitly instead of inventing phonemes. The Node evaluation asset loader requires Node 22.15 or newer with `node:module.registerHooks`; it only handles the exact installed word-list raw asset.

Use 16 completions and 180 seconds per supplemental trajectory, together with the candidate's cumulative stage output allowance and the campaign's total spending ledger. A valid tool call is mechanical evidence; whether the model chose the right correction still needs semantic review. Raw tool errors, refusal, missing handoffs and unchosen operations remain visible.

These are isolated audit-role calls. They do not prove actual audit→memory→summary consumption, persistent storage, restart recovery, speech recognition accuracy, or reliable repeated behavior. Those integration mechanics have separate deterministic tests. No visitor data is read or logged, and no training data is collected.

Run the adapter's deterministic contracts without inference:

```sh
npx tsx --test evaluation/test-background-sanity.ts evaluation/test-stock.ts evaluation/test-local-stock.ts
```
