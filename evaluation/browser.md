# Browser integration subset

`browser.ts` drives the actual built application in isolated Chromium contexts through Playwright; the candidate is the application's model, and the driver only performs the declared UI actions in `browser-scenarios.json` and observes rendered output, service receipts and IndexedDB state.

The loopback-only `browser-bridge.ts` is a developer adapter, excluded from the frontend and gateway runtime: it holds an explicit `OPENROUTER_API_KEY` outside the browser, forwards native provider SSE, reuses `CompletionQueue` and `FixtureLibrary`, records billing uncertainty, and applies bounded request/input/output/spend settings from a supplied candidate profile.

```sh
npm install
npx playwright install chromium
VITE_BASE_PATH=/ VITE_PROXY_BASE=/v1 VITE_STT_BASE=/api/asr-http VITE_TTS_BASE=/api/tts_streaming VITE_VOICE_BROKER=0 npm run build
# Copy browser-profile.example.json and fill in a model, observed prices,
# and any reasoning level required by that candidate.
npx tsx evaluation/browser.ts candidate.json receipts-new --contracts-only
# Explicit developer key supplied through the environment, never the browser.
npx tsx evaluation/browser.ts candidate.json receipts-paid-new
```

The example numbers are experiment work bounds, not admitted production limits; hosted context sizing uses an explicitly labelled conservative byte bound, so this subset does not establish native-tokenizer, local quantization, speech quality or production corpus retrieval qualification.

Each run freezes its built application and scenario/source/code digests, retains separate case JSON, screenshots, requests/responses and state observations, and leaves semantic answer/memory rubrics unadjudicated even when deterministic checks pass; `--contracts-only` exercises real queued and executing cancellation against a controlled transport with no paid model requests.
