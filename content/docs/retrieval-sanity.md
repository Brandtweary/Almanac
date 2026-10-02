# Retrieval sanity contract

The offline content suite checks retrieval wiring with a small authored corpus.
Six independent collections take turns supplying the best match, with both
library orders and mixed positive/negative lexical score scales. Queries cover
shared lexical terms, exact identifiers, semantic synonyms, encoder-window
overflow, document scope and continuation pages. Assertions cover expected
first-page evidence, collection coverage, both retrieval arms and complete,
duplicate-free cursor traversal under the serialized response budget.

The fixture uses real ingestion, SQLite FTS5, production service construction,
local tokenizer artifacts and the embedding/Qdrant HTTP adapters. An in-process
HTTP transport supplies deterministic vectors and cosine results. It makes no
network calls and downloads no models. Distinct chat and encoder tokenizers
make window ownership observable. Mock similarities test ranking mechanics;
they do not measure an embedding model's understanding.

This is a regression alarm with explicit expected answers, not a permanent
relevance benchmark or a release qualification. Each collection must win a
query that targets it; mere presence somewhere in a large candidate set is
insufficient. Independent lexical-only and semantic-only answers expose arm
loss. Mutation checks show that generation-rank fusion, chat-tokenizer query fitting
and silent empty results from either arm fail these assertions. Mutations run
in isolated child interpreters; the source tree stays unchanged and a final
control reruns the clean implementation.

Bug-free execution alone cannot establish ideal retrieval. Source coverage,
extraction, segmentation, title/lead-only native embeddings, encoder quality,
candidate depth and evidence budgets constrain recall. Reranking and diversity
selection remain optional ranking policies; no new policy or model is selected
by this check.

When changing the corpus, encoder, segmentation or ranking policy, perform a
small integration spot check against the installed library: choose a few clear
questions spanning its collections, include an exact identifier and a synonym,
inspect the first page and read the supporting passages. Record query, expected
source, observed rank, degradation and whether the answer-bearing text survived
the page budget. Investigate misses and retain a deterministic regression when
the failure is mechanical. This manual integration check is separate from the
unit suite and requires the installed services; it is not scheduled or claimed
as completed by offline tests.

The response budget is a profile choice sized to the chat role's context. Retrieval's `response_tokens` limits serialized evidence including its
metadata; the chat role's `maxOutputTokens` separately limits generated answers.
The sanity fixture exercises paging; `test_content.py` separately forces whole
excerpt omission and checks continued access to the immutable source. These
checks select neither limit.

## Running the check

From `content/`, in the environment installed from this package's test extra:

```bash
python -m pytest tests/test_retrieval_sanity.py -q
python tools/check_retrieval_mutations.py
python -m pytest tests -q
```

The seven sanity cases share six tiny ingested collections and finish in a few
seconds on a development host. Generated tokenizer JSON files and catalogs live
under pytest's temporary directory. The mutation runner verifies passing
controls before and after its four deliberately broken variants; assertion
failures are required, and import errors or skipped cases do not count as a
successful detection. Its deliberately failing pytest output is expected when
the command itself finishes successfully.

Native archive title/redirect handling and lazy passage localization have their
own offline tests in `tests/test_native_ranking.py`. They use controlled archive
objects. Real libzim extraction/index behavior remains in the separate
`tests_integration/` suite.

## Review boundaries and policy

The reviewed path spans browser tool arguments and evidence retention, gateway
forwarding, request validation, SQLite/native lexical retrieval, embedding and
vector adapters, cross-generation fusion, optional reranking, budget packing and
snapshot continuations. No additional defects were identified in the browser or
gateway forwarding code during this review.

Cross-generation dense similarities merge by value under a common encoder.
The current lexical merge uses within-collection ranks, weighted by each
collection's strongest dense score rank; it does not normalize raw BM25 values.
This avoids comparing SQLite's negative BM25 with native positive nested-RRF
scores. It also means dense quality influences lexical collection order, and
collections without dense hits have lower affinity. This remains an explicit
ranking tradeoff, not a relevance guarantee; no weight, candidate depth,
reranker activation or MMR policy changed.

Window checks use the model that will consume the text: encoder tokenization
for dense queries, reranker pair tokenization for reranking, and chat
tokenization for evidence output. A reranked prefix retains the unscored prefix
members followed by the untouched fusion tail, preserving cursor reachability.
Native title hits use canonical article identity before depth limiting, and
localization deduplicates resolved documents. Empty pages obey the same
serialized metadata budget as nonempty pages.
