# Self-hosting

Use the concrete source commands in [Linux installation](install.md) and [runtime startup](source-runtime.md); prepared portable manifests are a separate option. The browser, gateway, content service, inference, speech and indexes form one installation; a static frontend alone cannot answer reference questions. A release is ready only after its actual artifacts pass the recorded qualification checks.

## Service boundaries

| Service | Contract |
|---|---|
| Gateway | Serves the built browser application, validates the release profile, and admits one model completion at a time. |
| Inference | Local model, tokenizer and chat template; every role uses the same measured profile. |
| Content | Mandatory backend corpus with independent lexical and semantic retrieval, immutable source handles and explicit readiness. |
| Speech input | Whisper-compatible multipart HTTP transcription; the gateway exposes `/api/asr-http`. |
| Speech output | Kyutai msgpack streaming WebSocket; the gateway exposes `/api/tts_streaming`. |
| Personal-memory embeddings | Encoder-identified embedding service; unavailable dedup falls back visibly to string similarity. |
| Web discovery | SearXNG JSON search for normal connected use, with an explicit unavailable state when the web cannot be reached. |

The model and reference library use local artifacts. Web search remains available through the gateway when configured and connected; internal inference isolation does not require the whole application to be air-gapped. Hosted demonstrations use the same application and local models on the host; the visitor's browser sends chat/audio and consented memory context to that host. Local installation sends those requests to the user's own machine. Corpus files never become personal-memory entries automatically, and disabling personal memory leaves corpus access enabled.

## Browser and gateway configuration

[`.env.example`](../.env.example) describes browser overrides; [`proxy/.env.example`](../proxy/.env.example) describes local service endpoints and the release-profile path. Default browser routes use the application's origin. Vite loads environment files for the selected mode, and the production connection policy permits that origin plus explicitly configured service origins. Check `.env.local` when building a production bundle because Vite loads it in every mode.

`/health` reports gateway liveness as a supervisable document — a state, the timestamp of the last request a backend actually answered, and a 503 while the model does not answer — so an unattended installation can be watched without treating a served static page as a working service; `/ready` reports aggregate qualified readiness; `/v1/profile` describes capabilities, model and role limits. Candidate qualification is labelled separately and never makes `/ready` succeed. Missing corpus, missing model, invalid profile, full queue and failed inference remain distinct outcomes. See [gateway configuration](../proxy/README.md).

## Speech protocol

Input is a 16 kHz mono WAV sent as multipart data to an OpenAI-compatible `/v1/audio/transcriptions` backend. The gateway preserves the content type and forwards the browser's same-origin request. Failed transcription leaves an explicit retry path; typed chat remains usable.

Output uses a `{type:"Ready"}` WebSocket handshake, `{type:"Text"}` and `{type:"Eos"}` client messages, and `{type:"Audio", pcm:[...]}` response frames containing 24 kHz mono PCM. A voice backend may implement this protocol directly or through a bridge to batch synthesis. Model weights, codec weights, tokenizers and bridge dependencies are separate offline assets; container images do not include writable-layer caches or external volumes. Qualification measures first-audio latency and concurrent speech/inference memory use.

Speech implementations with idle unloading need explicit residency configuration and a verified warmup before readiness. For the retained Whisper implementation, `WHISPER__TTL=-1` preserves the loaded model; a transcription must actually enter the service to load the weights.

## Embedding identity and search

The personal-memory embedding endpoint returns `{encoder, embeddings}`. Its `/info.model_sha` must identify an immutable model revision; `/info.sha` identifies the serving binary and cannot substitute for the weights. Inputs never silently truncate, returned vectors must be finite and shape-consistent, and encoder identity is checked across the batch. Corpus embedding/index identity has its own generation contract in `content/`.

SearXNG must enable JSON output. Successful empty search, unavailable search and partially failed engines remain distinguishable. Search snippets are discovery material, not evidence that the assistant read a page.

## Hosting and supervision

The gateway serves both static files and APIs. The [Caddy example](templates/Caddyfile.example) mounts it under `/almanac/`, including WebSocket speech, so hosted requests retain the gateway's admission limits. Build with `VITE_BASE_PATH=/almanac/` and leave service overrides unset to inherit that prefix; the proxy strips the prefix before forwarding to the gateway. Microphone access requires a secure browser context: localhost is supported for local operation, while a public host uses HTTPS.

A publicly reachable installation depends on the gateway's per-client rate limits, which identify a client by socket peer unless `TRUSTED_PROXIES` names that peer. A terminator on the same host is covered by the loopback default; one on another host must be listed there and must set `X-Forwarded-For`, or every visitor counts against a single window.

The [user-service template](templates/almanac-gateway.service) supervises a direct gateway installation. Prepared container releases carry their own pinned runtime configuration. Keep inference, content and speech ports internal; expose only the application gateway deliberately.
