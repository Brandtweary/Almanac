# Reference tools

This internal service is independent of personal memory. The gateway forwards the same-origin
routes below and the browser registers them as `corpus_search`, `corpus_collections` and `corpus_read`. No installation
or filesystem-management endpoint is public. FastAPI `/openapi.json` exposes request schemas.

| Route | Input | Output |
|---|---|---|
| `GET /health`, `GET /capabilities` | None | `ready`, `generation`, `profile_id`, `qualified`, `coverage`, `degradation`, `unavailable_archives` |
| `POST /v1/corpus/search` | `query`, optional `document_id`, `cursor`, `require_qualified` | Common envelope, `hits`, `cursor` |
| `GET /v1/corpus/collections` | None | Common envelope, `collections` |
| `POST /v1/corpus/read` | `document_id`, optional `passage_id`, `cursor` | Common envelope, `document`, `overview`, `passages`, `cursor` |
| `GET /v1/corpus/source/{handle}` | URL-encoded returned passage handle | Immutable original bytes; ZIM article text |

Common envelope: `generation`, `profile_id`, `status` (`ok`, `unqualified`, `degraded`),
`degradation` (stage codes), `coverage`. Coverage identifies `active_packs`, `pending_packs`,
`content_only`, `exclusions`. A successful empty hit array differs from any failed stage.
A search also carries `result_set`, describing the ranked set the returned page is a slice of:
`total` hits behind it, the page's `offset` into them, and per `collections` entry the
`collection` a hit set belongs to, how many `hits` are its own, and the `best_rank` it reached.
A collection whose best rank falls past the page is present in the library and absent from the
response, which no stage code reports because no stage failed.
Generations index disjoint archives, so candidates are unified per branch before fusion: dense
scores compare directly across collections and merge by value, while lexical scores do not compare
and merge by rank weighted by each generation's dense standing. Ranking never depends on a handle.
Native archive lexical discovery combines exact-title navigation with full-text search through the shared ZIM adapter for both compact and passage-catalog generations; semantic retrieval remains independent.
Qualification describes measured retrieval quality separately from mechanical readiness.
`require_qualified` rejects unqualified profiles and any failed required retrieval stage.

A listing entry describes one installed collection: `title` (a native archive's prepared title,
otherwise the pack identifier), `category` (the part of the library it is listed under, empty when
it was prepared without one), `publisher`, `origin`, `language`, `articles`, `indexing_complete`,
`packs`, and for a staged pack the `works` it carries with the `additional_works` it only counts.
A category groups archives for display and is recorded outside the generation identity, so naming
or renaming one re-lists an archive without rebuilding its index.

Each hit or read passage contains:

- `passage_id`: opaque `p:<generation digest>:<source span digest>`.
- `document_id`, `source_revision` (original SHA256), `extraction_revision`, `title`, `edition`.
- `collection`: the work the document sits inside — the pack title for a native archive, the document's own publisher otherwise, and empty when it would only repeat the title. The catalog records no finer grouping, so a series named only in a document's body text is absent here.
- `section`: heading array; `page`: zero-based `index`, printed `label`, `coordinates`, `anchor`.
- `excerpt`, `complete`, `kind`, `flags`, `previous`, `next`.
- `source`: same-origin `url`, `sha256`, `media_type`, upstream `origin`, and
  `representation` (`original` or `article_text` for the text-only ZIM article route).

The source route names its response after the document's own title with the served type's extension, and marks a browser-renderable type `inline` under the route's sandbox policy; every other type is an `attachment`.

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
lexical results `degraded`; reranker failure labels fused results `degraded`.

A passage handle carries a digest of its own text, so a handle whose source bytes changed
resolves to `unknown_passage` and never to different text. A fresh search or a read by
document identity carries no such reference, so for those the protection is integrity:
an archive admitted to it has every leaf re-read from the medium on a schedule and the
leaves of a document re-hashed before it is read, and a document whose bytes are damaged
is refused with `source_damaged` (503), including through a handle into it, which was
valid and is not reported as unknown ([integrity](integrity.md)). An archive not admitted
is checked only against its receipt's size and modification time, which does not read
its bytes; its coverage entry says it is not admitted.

Integrity damage costs what it touches. Search drops hits on damaged documents and adds
`integrity:<pack>` to `degradation`; `integrity:<pack>:lexical` means that archive's
search index is withdrawn, `integrity:<pack>:dense` that its dense index failed
validation, and `integrity:<pack>:withdrawn` that the whole archive is out of service.
`integrity:<pack>:read_unverified` on a read means the archive is admitted but its text was
served without the read-time re-hash, and the source route's `X-Integrity-Read` header
carries the same outcome (`verified`, `not_admitted` or the reason the re-hash did not run).
`archive_unavailable:<pack>` means an archive could not be read for this request. Health
excludes an unavailable or withdrawn archive from its checks, names it in
`unavailable_archives` and `degradation`, and stays ready while any archive serves;
qualification is judged over the archives serving. Each `coverage.native_archives` entry
carries an `integrity` block: whether the archive is `admitted`, the `verified_fraction`
of its leaves verified within the scrub window (a leaf never verified counts as
unverified), damaged, unrepairable and pending-reload leaf counts, `damaged_documents`
(null when some damage could not be localised), `lexical_withdrawn`, `withdrawn` with its
reason, `last_full_pass`, `network_sources_available`, `upstream` (a newer listed edition
and whether the installed one is still listed), `read_verification` (`active`, or why
reads are not being re-hashed), `manifest` and `corpus_root`.
`precomputed_undecodable` counts precomputed articles that no longer decode and fell back
to the archive.

A query longer than the sentence encoder's window is accepted, not rejected: the dense branch
encodes the leading portion that fits and the results carry `dense_query_truncated`, so a narrower
dense contribution is visible rather than reported as full coverage. The lexical branch searches the
whole query, and indexed passages are never truncated.

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
