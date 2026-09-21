# Native archive preparation

Run these owner commands from `content/` in the installed Python environment. The embedding and Qdrant services, libzim, source archive and tokenizer files must already be installed locally; the commands do not download model weights or invoke a chat model. Acquisition commands and exact archive pins are in [installation](../../docs/install.md).

## Create the query/index profile

```sh
PYTHONPATH=. python tools/configure_profile.py \
  --output /srv/almanac/content-profile.json --id local-library-candidate \
  --encoder-tokenizer /srv/almanac/encoder/tokenizer.json \
  --chat-tokenizer /srv/almanac/chat/tokenizer.json \
  --embed-url http://127.0.0.1:8899 \
  --response-tokens 4000 --read-tokens 8000 --vector-datatype float16
```

The generator reads the embedding backend's immutable revision and measures its output dimension with one fixed probe, hashes both supplied tokenizer artifacts, and writes portable relative paths. `--encoder-id` supplies the portable model identity if the backend reports a local model directory. The response/read budgets are explicit operating choices; select them to fit the installed chat role and evaluate source retention. A generated profile is unqualified. Its presence does not establish retrieval quality or offline readiness.

Float16 is an explicit vector-storage datatype, not a second quantized copy; measure retrieval drift for the chosen corpus before qualification. The encoder/segmentation identity remains compatible across the library union, while each generation separately binds its storage datatype and semantic representation. Query-profile changes such as chat tokenizer or response budget reuse compatible source indexes.

## Prepare an archive

```sh
PYTHONPATH=. python tools/prepare_native.py \
  --profile /srv/almanac/content-profile.json --data /srv/almanac/content-state \
  --archive /srv/almanac/sources/appropedia_en_all_maxi_2026-02.zim \
  --sha256 dcf200ba723c27397e1c9a2e4891ff91fa13993df1fa285315190d8525a53469 \
  --pack-id appropedia-en-2026-02 --title Appropedia --publisher 'Appropedia contributors' \
  --source-base-url https://www.appropedia.org --license CC-BY-SA-per-page \
  --selection-policy appropedia-open-english-v2 \
  --inspection inspections/appropedia-2026-02-html-v4.json \
  --content-state-reserve-bytes <free-space floor for the content state> \
  --index-storage-reserve-bytes 27917287424 \
  --index-storage /srv/almanac/index/qdrant \
  --workers 4 --embed-url http://127.0.0.1:8899 --qdrant-url http://127.0.0.1:6333
```

The archive is verified and hardlinked on the same filesystem into the content state; cross-filesystem publication requires a copy and its extra capacity. `--index-storage` identifies the local Qdrant storage directory, and `--index-storage-reserve-bytes` caps allocation across it; `--content-state-reserve-bytes` is the separate free-space floor on `--data`, which the pre-flight and in-flight low-space checks measure against. A pack whose content-state components are declared unmeasured carries no computed figure for that floor, so it is the operator's own margin for the article-spans artifact rather than a number read off the report. The example index reservation is a conservative provisional peak allowance for a complete-article encyclopedia plus the practical archive; actual required space remains a deployment measurement, and filesystem growth checks are not a hard quota on an asynchronous database optimizer.

For Wikipedia use its exact acquired nopic SHA-256, `--pack-id wikipedia-en-nopic-2026-06`, `--source-base-url https://en.wikipedia.org/wiki`, `--license CC-BY-SA-4.0`, `--selection-policy canonical-html` and the matching checked inspection receipt. Canonical HTML includes full articles; redirects resolve to their canonical targets, and non-HTML assets are not vector documents. The Appropedia policy requires an English article-body language declaration, applies the documented CC-BY-SA-4.0 default when page metadata selects that default, and respects explicit alternative licenses plus the inspection receipt’s source-bound exception map. Copyright discussion, bibliographic references and permission acknowledgements are not blanket exclusions; the four recorded unresolved contrary notices are source-serving choices, not legal verdicts, and this selected text scope does not clear every archive image or imported document.

Run the same command to resume. A durable entry cursor advances only after successful vector upsert, so replay is idempotent. The active union retains unrelated archive/catalog packs; replacing one pack selects its new generation while historical handles remain readable. A partial replacement of a catalog containing several packs is refused rather than silently dropping its remaining packs.

## Precompute article spans

A prepared generation answers correctly before this step and slowly: the first search to touch an
article decodes, block-parses and segments it. One pass over the archive stores that result beside
the generation.

```sh
PYTHONPATH=. python tools/precompute_passages.py \
  --data /srv/almanac/content-state --workers 16
```

Without `--generation` it covers every active native generation. Measured over uniformly sampled
English Wikipedia articles, a build costs about 44 ms of one core per article — decode 3 ms, HTML
parsing 32 ms, segmentation 9 ms — and stores about 2.8 KB, so an eight-million-article archive is
roughly 24 GB and a few hours across sixteen workers. `--min-free-bytes` (8 GiB) stops the build and
publishes what it reached rather than filling the filesystem.

Run the same command to resume. The artifact is written under a building name and moved into place
when the run ends, whether by completing, by the disk floor, by an error or by a signal; a resume
moves a published artifact back under the building name first, so the live service never reads a file
being written and loses the precompute for the duration of that resume. `article-spans.status.json`
beside the artifact carries the run's own account of itself — cursor, stored articles, failures,
rate, remaining estimate and terminal state — so a build that died is legible without the console it
was started from. Partial coverage is safe by construction: an article the build never reached is
segmented at query time the way every article was before. The service reads the artifact at startup,
so a completed build is picked up by restarting it.

## Coverage and serving

The data root contains `active.json`, immutable `originals/<sha256>` and `generations/<generation>/manifest.json`. Native generations keep a pinned tokenizer but no duplicate full-text catalog or extraction cache. Complete source reading and the native full-text branch become available before semantic indexing completes; every response discloses `dense_stage`, indexed count, entry cursor/population, source selection and the title/lead representation. Incomplete dense indexing is explicit degradation and cannot satisfy required qualified retrieval. Extraction v4 preserves superscript/subscript and supported mathematical notation and flags omitted unsupported math; explicit v3 dispatch retains historical native text, while unknown revisions fail instead of silently reinterpreting handles. Article vectors do not claim to semantically encode every later paragraph; full-body lexical discovery and original reading are independent capabilities.

```sh
CONTENT_STATE_DIR=/srv/almanac/content-state \
CONTENT_PROFILE=/srv/almanac/content-profile.json \
CONTENT_EMBED_URL=http://127.0.0.1:8899 \
CONTENT_QDRANT_URL=http://127.0.0.1:6333 \
PYTHONPATH=. python -m oracle_content
```

Inspect `/capabilities` and both real search/read responses before enabling an application gateway. `ready` means the declared source path is available; `qualified` additionally requires a qualified profile and complete dense indexes. Final query-quality and disconnected-function checks remain necessary.

## Optional GPU bulk encoding

The ordinary command uses the installed embedding service. A separately measured owner-side worker can accelerate initial indexing through `--bulk-encoder-command COMMAND.json`, where the file contains an argv array, never shell text. The JSONL process must announce matching encoder ID/revision/tokenizer digest/dimensions and return one finite vector per input. `tools/torch_encoder.py` provides a BERT attention-masked mean/L2 worker using locally pinned safetensors; it takes explicit model identity, revision, weight SHA-256, maximum tokens and batch size and downloads nothing.

Run it in a pinned compatible torch/transformers environment, prove vector parity against the normal query encoder on representative text, record peak GPU memory/throughput, and coordinate its GPU allocation with chat/speech before use. The worker is an indexing tool, not an additional public service. Its profile batch size must fit the declared worker limit; profile defaults intended for a smaller HTTP embedding batch are not changed automatically.
For a Docker worker, include `--log-driver none` in its `docker run` arguments: stdout carries the embedding protocol, and the default container logger would retain another large copy of every vector. The attached process still receives stdout; builder failures and checkpoint metrics remain recorded separately.

`tools/measure_capacity.py` measures the original passage-catalog representation without creating a full index. Its estimates include failure lists and sampling uncertainty; they must not be confused with the compact native representation or treated as full-corpus measurements.
