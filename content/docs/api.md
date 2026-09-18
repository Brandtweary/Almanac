# Reference tools

This internal service is independent of personal memory. The gateway forwards the same-origin
routes below and the browser registers them as `corpus_search` and `corpus_read`. No installation
or filesystem-management endpoint is public. FastAPI `/openapi.json` exposes request schemas.

| Route | Input | Output |
|---|---|---|
| `GET /health`, `GET /capabilities` | None | `ready`, `generation`, `profile_id`, `qualified`, `coverage` |
| `POST /v1/corpus/search` | `query`, optional `document_id`, `cursor`, `require_qualified` | Common envelope, `hits`, `cursor` |
| `POST /v1/corpus/read` | `document_id`, optional `passage_id`, `cursor` | Common envelope, `document`, `overview`, `passages`, `cursor` |
| `GET /v1/corpus/source/{handle}` | URL-encoded returned passage handle | Immutable original download; ZIM article text |

Common envelope: `generation`, `profile_id`, `status` (`ok`, `unqualified`, `degraded`),
`degradation` (stage codes), `coverage`. Coverage identifies `active_packs`, `pending_packs`,
`content_only`, `exclusions`. A successful empty hit array differs from any failed stage.
Native archive lexical discovery combines exact-title navigation with full-text search through the shared ZIM adapter for both compact and passage-catalog generations; semantic retrieval remains independent.
Qualification describes measured retrieval quality separately from mechanical readiness.
`require_qualified` rejects unqualified profiles and any failed required retrieval stage.

Each hit or read passage contains:

- `passage_id`: opaque `p:<generation digest>:<source span digest>`.
- `document_id`, `source_revision` (original SHA256), `extraction_revision`, `title`, `edition`.
- `section`: heading array; `page`: zero-based `index`, printed `label`, `coordinates`, `anchor`.
- `excerpt`, `complete`, `kind`, `flags`, `previous`, `next`.
- `source`: same-origin `url`, `sha256`, `media_type`, upstream `origin`, and
  `representation` (`original` or `article_text` for the text-only ZIM article route).

Null page metadata is unknown, never inferred from a PDF page index. Figures are explicitly
marked as needing visual inspection; the text-only model cannot inspect their geometry.
A table too large for the encoder keeps its complete readable source text and indexes a labeled
inspection reference. Search packing omits entire text, with `text_omitted_budget`, rather than
silently clipping a warning. If even metadata exceeds the profile budget, the request fails.

Without `passage_id`, read returns a paginated contents overview (`overview: true`) using the
same passage schema with omitted body text. With a handle, read starts at its preceding neighbor
and continues in original document order. No global ranking occurs during reads. A cursor is
bound to the original query/document/handle and profile; repeating it returns the same immutable
snapshot even after activation of a new corpus. It is not a filesystem path. A cursor is short-lived:
its snapshot expires on age or storage ceiling and then reports `invalid_cursor`, which asks the caller
to repeat the search. Passage handles and source URLs remain valid regardless, so nothing already cited
depends on a retained cursor.

Errors use `{error: {code, message}, request_id}`. Malformed requests/cursors are 400,
unknown documents/passages 404, unavailable historical generations/originals 410,
index/profile readiness failures 503. Lexical failure blocks search. Dense failure labels
lexical results `degraded`; reranker failure labels fused results `degraded`. A source checksum
failure never serves different bytes under an old handle.

The server logs generated request IDs, methods, statuses and durations, excluding queries,
conversation text and memory. A failing retrieval stage additionally records its stage, exception
type and traceback frames — never query-bearing text — to `failures.jsonl`, which rotates within the
`CONTENT_FAILURE_LOG_MAX_BYTES` allotment and folds a repeating identical failure onto occurrences
1, 2, 4, 8, … under a stable `fingerprint` with its `count` ordinal. Recording never alters the
response: a failed stage still reports itself through `degradation`. Proxy disconnect cancels
outstanding HTTP retrieval work.

## Optional phonetic hints

`POST /v1/phonemize` accepts `{texts: string[], language: "en-us"}` and returns
`{phonemes: string[], engine: {name: "espeak-ng", version: string, voice: "en-us"}}`.
Output order exactly matches input order. The native engine uses plain `--ipa`; consumers may remove
stress marks and whitespace for comparison. One process handles each request using native line-by-line
stdin mode, which calls the engine separately for each newline-terminated input; output alignment and per-item size are checked. Input text is never interpolated into a shell or command options.

A batch has at most 256 entries, each 1–64 NFC-normalized Unicode letters, marks, numbers or ASCII spaces, with at least one
letter or number. Controls, punctuation and other Unicode categories are rejected. The encoded HTTP body is bounded at 128 KiB before parsing, including chunked requests.
The engine has no pending queue: by default two requests may run, each with an eight-second total
execution deadline. Excess work returns `phonemizer_busy` (503); expiry returns `phonemizer_timeout`
(504). Disconnect, timeout and subprocess failures reap owned processes before releasing admission.

`/health` and `/capabilities` expose `phonemizer` readiness, version, voice, limits and an unavailable
reason. Missing native dependencies return 503 from this optional route and do not change corpus
readiness. No personal text, vocabulary identifiers or pronunciation cache is stored on the server;
request logging contains only request identity, status and elapsed time. Ordinary transcription does
not depend on phonetic hints.
