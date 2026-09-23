# Offline reference content service

A Python service owns immutable source generations, SQLite FTS5 retrieval and source reading.
It independently queries a local Qdrant vector index through a pinned local embedding service,
combines ranks, and optionally applies a qualified local reranker. It does not run an additional
LLM research agent. The browser chooses what to search and read.
Native archive lexical queries require all supplied terms, so use concise topic terms and refine or scope the query when necessary; Boolean operators are not supported by libzim.

Install this package using the deployment preparation workflow. Run `python -m oracle_content`
with `CONTENT_STATE_DIR`, `CONTENT_PROFILE`, `CONTENT_EMBED_URL`, `CONTENT_QDRANT_URL` and, for a
reranker profile, `CONTENT_RERANK_URL`. `CONTENT_HOST` defaults to loopback and `CONTENT_PORT` to
8791. Model artifacts and tokenizer JSON files must already exist locally; startup never downloads
them. For fully offline TEI startup, supply a verified local model directory and its pinned revision;
`encoder_runtime_id`/`reranker_runtime_id` record the runtime directory identity separately from
portable model identity. Moving that directory does not invalidate stored corpus vectors.
Python 3.11 or newer and SQLite with FTS5 are required. Optional `extraction` dependencies
provide Docling and libzim; their dependency licenses accompany a distributed installation.

`tools/configure_profile.py` creates an explicitly unqualified profile from installed tokenizer bytes and the pinned embedding backend; `tools/prepare_native.py` prepares a resumable compact ZIM generation in the active library union, with complete original reading/native full-text retrieval and explicitly title/lead-only dense discovery.
The [native archive setup](docs/native-install.md) gives the complete invocation, source-inspection, coverage, storage-reservation and optional offline bulk-encoding contracts.

`tools/inspect_remote_zim.py` reads a published archive's header and `M/Counter` metadata over HTTP range requests, so the article count a pack manifest's index footprint is derived from is checkable in tens of kilobytes rather than by acquiring the archive. Run it as `PYTHONPATH=. python tools/inspect_remote_zim.py <url>`; it needs the `extraction` extra, whose `zstandard` decodes the clusters every Kiwix archive uses.

`tools/build_pali_canon_zim.py` renders SuttaCentral's CC0 English translations of the Pali canon into a natively indexed ZIM, writing a receipt that counts what it produced against what the source declares; `tools/verify_pali_canon_zim.py` reads that archive back, resolving every declared text and comparing it segment by segment against the source, because an archive that is well formed and empty passes every cheaper check. Both require the `extraction` extra, and `tests_integration/test_pali_canon_zim.py` exercises them against archives broken on purpose.

`tools/build_survivor_text_zim.py` turns a crawl of scanned books into a natively indexed text archive, one article per book at the path its scan has in the crawl: each book's text is its PDF's own text layer or, for an image-only scan, the Internet Archive's OCR of the same scan, admitted only when title, year, volume and page count agree. The archive names the crawl in its `Scans` metadata, and the source route serves a book's scan in place of its text whenever that crawl is installed among the originals. `tools/inspect_native.py` writes the inspection receipt a native preparation binds, from a seeded sample of the archive read through the build's own extraction and selection. Both require the `extraction` extra.

`oracle_content.models.Profile` is the strict release-profile schema. It requires explicit encoder
identity/revision/dimensions/tokenizer digest/window, chat tokenizer digest, candidate depths, fusion
weights/constant, token budgets, batching and timeouts. `qualified` remains false until evaluation
receipts exist. No chat/embedding/reranking model or measured winning configuration is shipped by
this package. Mechanical tests do not qualify extraction or answer quality.

The owner-only Python API `oracle_content.ingest.build` accepts a stream of verified `Document` manifests,
extraction-inspection receipts, the profile and adapters. It publishes immutable original bytes,
streams document manifests and extraction receipts through SQLite, extracts ordered blocks, creates a staging lexical catalog, resumes embedding batches, validates
all dense identities/vectors, then atomically switches `active.json`. Each failure retains its stage
and full worker traceback. It leaves the previous generation active. Changing source/extractor or
encoder/segmentation identity produces a new generation. Ranking settings, output budgets and
qualification receipts identify the query profile separately and reuse compatible existing indexes. Unchanged original/extractor pairs reuse
validated extraction bytes while new encoder identities rebuild dense vectors. Historical generations are retained; no automatic deletion policy can invalidate
a conversation's sources, which are content-addressed passage handles rather than stored result sets.
Search/read snapshots are only the continuation cursors of a result set still on screen, so they expire:
`CONTENT_SNAPSHOT_TTL_SECONDS` (900) and `CONTENT_SNAPSHOT_MAX_BYTES` (256 MiB, oldest evicted first,
never the newest) bound what an unauthenticated visitor can accumulate on disk. Following an expired
cursor reports `invalid_cursor` and the search is repeated.
A native archive has no extracted text catalog, so lexical retrieval localizes each article hit by
decoding, block-parsing and segmenting the whole article — interpreter-bound work that gains nothing
from running searches at the same time. `CONTENT_LEXICAL_CONCURRENCY` (1) admits searches into that
stage in arrival order, so the first is answered at one search's cost instead of every search
returning at the cost of all of them. A cancelled search does not release its admission: cancelling
the coroutine awaiting a thread does not stop the thread, so the gate is released by the localization
itself rather than by whoever was waiting on it.

`tools/precompute_passages.py` moves that per-article work to a one-time pass over the archive,
storing each article's extracted blocks, its segmentation spans and its semantic representative in
`generations/<generation>/article-spans.sqlite`. Passage handles are unchanged: the build runs the
same segmentation the query path runs, reconstructs passages from what it is about to store and
refuses any article whose reconstruction is not identical field for field. The artifact is an
optimization and never a definition — an article it does not cover, an interrupted build and an
artifact bound to another generation all leave the original query-time path in place, and
`coverage.native_archives[].precomputed_articles` reports how much of an archive it covers.
Retrieval-stage failures record their stage and traceback to `failures.jsonl` under a fixed disk
allotment: `CONTENT_FAILURE_LOG_MAX_BYTES` (64 MiB) covers the live file and one rotated predecessor
together, so ordinary request traffic cannot grow the store without limit. A repeating identical
failure is written at occurrences 1, 2, 4, 8, … carrying its `fingerprint` and `count` ordinal, so one
recurring fault reports its rate without evicting the evidence of every other failure.
The deployment data root can move because stored original paths are relative to it.
With `managed_originals=True`, verified installer-managed immutable objects use same-filesystem
hardlinks; cross-filesystem objects require a copy and corresponding staging space. Arbitrary user
files are copied by default to preserve citation identity. Dense validation uses disk-backed identity
and duplicate ledgers rather than materializing the complete encyclopedia point set in memory.

HTML and EPUB adapters preserve headings, tables and original order. PDF extraction uses local
Docling assets and OCR, with explicit `CONTENT_EXTRACTION_THREADS`, CPU-only placement and automatic OCR downloads disabled, preserving page index and coordinates; printed page labels remain explicitly
unknown until inspected. Each adapter/extractor revision requires representative inspection receipts before activation, including
column/table/diagram cases for PDFs; every document separately passes automated checksum, parse and
nonempty-block checks. Optional document-specific inspection overrides bind its original checksum.
Failures stay visible in the extraction SQLite database and prevent partial activation. Parser success
is not evidence of layout fidelity. No person must approve every encyclopedia article.

Native ZIM lexical indexes are reused. `ingest.zim_documents` streams article manifests from a verified
archive; redirects resolve through the archive and canonical article text is indexed once. Documents declare exact article paths; only articles present
in both generation indexes are searchable, so installation must enumerate/ingest the intended article
scope and report exclusions. Native article hits undergo temporary per-article FTS5 localization, so a matching
identifier late in an article enters lexical candidates. Native article rank and within-article
passage rank combine through nested RRF; raw BM25 scores from separate articles are never added.
This explicit ranking choice still requires quality calibration. Archives without native full-text indexes use extracted FTS5.

See [API contracts](docs/api.md). `Service.candidates` exposes branch ranks and the fused candidate
pool for evaluation without a public diagnostic endpoint. Run mechanical tests with
`python -m pytest tests`; they make no external network calls. `pytest` is a
development dependency of the service's own environment —
install it into the virtual environment that runs it, so the suite runs against the
interpreter and packages the service actually uses. Whole-stack offline, real archive,
layout fidelity, large-pack performance and target-hardware quality remain release measurements.

Implementation references: [SQLite FTS5](https://www.sqlite.org/fts5.html),
[Qdrant query API](https://api.qdrant.tech/api-reference/search/query-points),
[libzim reader/search API](https://python-libzim.readthedocs.io/en/latest/), and
[Docling usage](https://docling-project.github.io/docling/usage/).

Optional real-archive integration: install the pinned `libzim` dependency and run
`python -m pytest tests_integration`. This creates an indexed miniature ZIM locally, verifies a late
identifier enters lexical results, and confirms no duplicate whole-archive FTS index is built.

`tools/measure_retrieval.py` runs explicitly selected development fixtures through real independent
retrieval, a pinned cross-encoder and explicit MMR weights. It freezes identical candidate pools,
uses the profile tokenizer on the actual serialized evidence fields, and reports original and
versioned structural labels separately. The diagnostic tokenizer is not a selected chat model;
these results do not qualify answer synthesis or full-corpus deployment.

Optional phonetic hints use a separately installed `espeak-ng` executable and matching data files.
`CONTENT_ESPEAK_BIN` selects its executable; `CONTENT_PHONEMIZE_MAX_ACTIVE` and
`CONTENT_PHONEMIZE_TIMEOUT` bound admission and execution. Startup probes engine version and the selected voice using fixed non-personal text, and
missing/invalid optional configuration exposes an unavailable capability without blocking the corpus.
See `native-dependencies.json` for source/license and deployment-receipt metadata. The MIT browser
bundle contains no native speech engine. Native phonemization integration tests run separately under
`tests_integration/test_phonemize_native.py` and require the system package.
