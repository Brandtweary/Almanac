# Almanac

Browser-local voice/text agent with optional personal memory and a mandatory backend reference corpus.

- The browser runs the Pi agent and controls conversation, recording, playback and consent; the gateway serves the application and routes local inference, corpus and speech requests.
- Corpus knowledge and personal memory have independent stores and lifecycles: reference tools remain available when personal memory is off.
- The whole local runtime uses a pinned release profile with measured model, tokenizer, tool-parser, context and resource settings; candidate qualification is explicitly labelled and never reports production readiness.
- Published repository: keep private paths, hosts, workspace notes, live memories and credentials out of tracked files; preserve upstream software and content attributions.
- About explains verified product capabilities and hosting/privacy boundaries; it contains no owner biography. README, installation and reference documentation describe actual capabilities.

## Architecture and documentation

- `src/main.ts` owns the browser lifecycle, Pi agent, sessions, consent, prompt and voice wiring; `docs/browser-oracle.md` describes its serving and context contracts.
- `src/local-model.ts` loads `/v1/profile`; `oracle-runtime.ts` shares role admission, exact request-token counting, queue status and cancellation across callers.
- `src/corpus-tools.ts` exposes search/read and immutable evidence handles; `oracle-context.ts` preserves evidence identity through bounded context and compaction.
- `src/kg/` implements a term glossary, not a graph: labels, descriptions, aliases, literal matching, optional stemming and encoder-aware similarity.
- `src/pipeline.ts`, `pipeline-tools.ts`, `memory-storage.ts`, `memory-archive.ts` and `memory-state.ts` own consent-gated personal-memory work and durable role evidence; `docs/memory-transactions.md` specifies durable stage coverage and atomic publication.
- `src/stt.ts` uses batch Whisper HTTP transcription; `src/tts.ts` uses the Kyutai msgpack streaming protocol and local playback. Audio controls remain explicit, with typed chat independent of speech failures.
- `speech/` provides the CPU Pocket TTS backend with public stock Alba, verified offline assets and cancellation-safe MessagePack streaming; its source recipe and attribution are in `speech/README.md`.
- `src/pi-web-ui/` is the vendored Lit/Tailwind interface; the pinned Pi agent libraries provide the agent loop. `src/pi-ai-slim-compat.ts` limits browser provider imports.
- `proxy/` contains the Bun/Hono gateway, one-active-completion queue and bounded speech forwarding; `proxy/README.md` describes routes and configuration. The About page's email sign-up writes to a SQLite file the gateway only ever appends to; no mail is sent and no route reads it back.
- `content/` contains the Python corpus service, staged ingestion, immutable SQLite catalog, native ZIM lexical integration and persistent dense-index adapters.
- `deploy/` contains the single setup entry, acquisition manifests and offline packaging; `docs/install.md` is the installation contract.
- `evaluation/` separates retrieval, source reading, tool research and retained-role evaluation; hosted screening belongs only to developer evaluation.

## Ownership and persistence

- Session loads, imports, deletions and consent changes invalidate stale asynchronous work before it can publish to replacement state.
- IndexedDB writes use transaction completion and revision checks; conflicting tabs fail visibly instead of overwriting another revision.
- Personal retrieval, tools, context injection, speech adaptation and background mutation require consent; revocation invalidates queued and in-flight authority while preserving saved data until explicit deletion.
- Immutable corpus handles identify exact source/extraction versions; source text is untrusted reference content, and citation identity alone does not establish support for a claim.
- Retrieval ledgers commit with their corresponding state changes; source evidence remains inspectable after compaction.
- Agent lifecycle listeners stay short and failure-contained because the Pi loop awaits them; one speech stream spans a turn, including pauses for tool calls.

## pi-web-ui workarounds (why the frontend looks weird)

The vendored UI layer (`src/pi-web-ui/`) is broken as shipped; these patches live in `main.ts` and the
vendored components, and are load-bearing, not cruft:

- **Vanishing messages** — pi-agent-core mutates `state.messages` in place, so the committed
  `<message-list>` (identity-only reactivity) skips re-render. Fixed at the source: `AgentInterface`
  keeps its own `_stableMessages` clone and re-takes it on every lifecycle event but per-token
  `message_update` (message completion / turn boundaries), giving Lit a fresh identity to react to;
  the send button reverts via a deferred update after `agent_end` (finishRun flips `isStreaming`
  with no event). `main.ts` only pokes the view — `repaintChatAfterExternalEdit()` →
  `agentInterface.refreshMessages()` — for edits the agent emits no event for (voice placeholder
  bubbles, compaction rewrite). (The shipped example also listens for a phantom `state-update` event;
  we bind the raw lifecycle events instead.)
- **Mount-once ChatPanel** — mount it once outside the reactive render root and never re-render it.
- **Tools assigned after `setAgent`** — `toolsFactory` is passed empty and `agent.state.tools` is
  overwritten with our own set (corpus tools, online search, and consent-gated personal-memory tools). One reassignment
  covers newSession AND loadSession.
- **Listener async-safety** — core awaits each listener; a throw or heavy work stalls the run. The
  whole listener body is try/caught and only re-renders on meaningful events.
- **Conversation markup** — `SafeMarkdown` sanitizes parsed markdown before DOM insertion while preserving code blocks, MathML and corpus citation handles; `sanitizeChatAnchors()` resolves those handles against the evidence ledger after each commit. Document previews sanitize detached parser output before attachment, and imported attachments share live-ingress resource limits.

## Development

- Browser: `npm run dev`, `npm run check`, `npm run build`; offline regression scripts live in `scripts/` and `test/`.
- Gateway: run `bun test` and `bun run check` inside `proxy/`.
- Content and evaluation dependencies/tests are documented in their own directories; network/model integration checks remain separate from offline unit tests.
- Browser endpoints default to the serving origin; explicit `VITE_PROXY_BASE`, `VITE_STT_BASE` and `VITE_TTS_BASE` overrides also constrain production CSP through Vite's loaded environment.
- Preserve the current layout/palette and retained voice/session functionality while changing backend contracts.
