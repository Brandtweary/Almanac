# Linux source installation

Almanac combines a local model and installed reference library with normal web access through its search tool. Start with [source-based local setup](#source-based-local-setup) for the current build; [web search](web-search.md) supplies current online discovery, while installed capabilities can also operate without it. `python3 deploy/setup.py` acquires pinned source packs and supports prepared release manifests; a certified portable production bundle is not supplied. The checked-in runtime recipe uses a 131,072-token context with BF16 KV storage and CPU speech, while complete-library, long-window and offline-release qualification remain separate checks. The gateway and speech interfaces are described in [self-hosting](self-hosting.md).

## Source-based local setup

The source route runs the browser, gateway and content service with installed model/reference assets and separately configured web search. It requires Linux, Python 3.11+, Node.js/npm, Bun, and the selected model/embedding/index/speech runtimes. Prepare dependencies and model files while connected; running the application afterward must use local file paths and endpoints. A model-weight download alone does not produce a complete corpus installation.

```sh
git clone https://github.com/Brandtweary/Almanac.git almanac
cd almanac
npm ci
npm run build
(cd proxy && bun install --frozen-lockfile)
python3 -m venv .venv
.venv/bin/python -m pip install './content[extraction]'
export ALMANAC_DATA="${XDG_DATA_HOME:-$HOME/.local/share}/almanac"
mkdir -p "$ALMANAC_DATA"
```

Next follow [source runtime startup](source-runtime.md) to acquire the exact chat, encoder and transcription files, pull the pinned images, and start isolated inference plus persistent Qdrant and local speech input. That guide produces the model paths and service endpoints consumed by the commands below; it does not assume an already-running model.

Native Python wheels require the system C++ runtime (`libstdc++.so.6`); on NixOS, expose the installed GCC runtime library directory through `LD_LIBRARY_PATH` when running the virtual environment because `NIX_LD` alone does not supply Python extension dependencies. Verify the installed environment with `.venv/bin/python -c "import oracle_content, libzim, tokenizers"` before starting the service.

Install the optional `espeak-ng` system package if pronunciation hints are wanted. Its absence does not disable typed corpus chat or ordinary transcription. Prepare the chosen PDF/OCR assets separately; the content process must not fetch extraction models at first use.

Acquire reference originals through the same setup entry. Complete English article text is the selected Wikipedia format:

```sh
python3 deploy/setup.py --release deploy/packs/wikipedia-en-nopic-2026-06.json \
  --data "$ALMANAC_DATA/sources" --prepare-only --connections 4
python3 deploy/setup.py --release deploy/packs/appropedia.json \
  --data "$ALMANAC_DATA/sources" --prepare-only
python3 deploy/setup.py --release deploy/packs/cd3wd.json \
  --data "$ALMANAC_DATA/sources" --prepare-only
```


Before starting the reference service, provide the selected content profile and a published source generation. Native full-text search and complete original reading can be available while dense indexing continues; the service reports that incomplete semantic coverage explicitly and remains unqualified. The profile describes exact encoder/tokenizer identities and retrieval settings; [the content package](../content/README.md) documents the ingestion API and its receipts. The gateway profile independently describes the selected local language model, tokenizer/template and per-role resource budgets; [gateway configuration](../proxy/README.md) documents that schema. These files are outputs of preparing and measuring the chosen runtime, not API keys. Do not fill missing admission measurements with guessed values. An empty content state directory cannot answer corpus questions.

A local candidate runtime profile can be generated from the checked-in pinned descriptor using the existing qualification adapter:

```sh
./node_modules/.bin/tsx evaluation/local-stock-run.ts \
  --runtime deploy/muse-glimmer-vllm-candidate.json \
  --prepare-profile "$ALMANAC_DATA/runtime-profile.json" \
  --context 131072 --output-tokens 2048 --stage-output-tokens 16384
```

This command starts no model and downloads nothing. The 131,072-token context matches the checked-in single-GPU runtime descriptor: BF16 KV storage (`--kv-cache-dtype auto`), a 2,415,919,104-byte cache allocation and CPU Pocket TTS. The output and cumulative stage budgets remain distinct from context capacity. These settings describe the measured candidate hardware configuration, not universal machine limits or completed release certification; validate allocations and speech overlap on the installation hardware. [Local qualification](../evaluation/local.md) documents the native tokenizer counts and unchanged case runner. Its dedicated synthetic qualification gateway is for benchmark fixtures; use the real application gateway below for corpus chat.

The content package also provides explicit profile and native-archive preparation tools. Point both tokenizer variables at the exact locally installed JSON files; the encoder service must expose its pinned model revision through `/info`:

```sh
export CONTENT_EMBED_URL="${CONTENT_EMBED_URL:-http://127.0.0.1:8899}"
export CONTENT_QDRANT_URL="${CONTENT_QDRANT_URL:-http://127.0.0.1:26333}"
export ENCODER_TOKENIZER="$ALMANAC_DATA/models/encoder/tokenizer.json"
export CHAT_TOKENIZER="$ALMANAC_DATA/models/chat/tokenizer.json"
.venv/bin/python content/tools/configure_profile.py \
  --output "$ALMANAC_DATA/content-profile.json" --id local-candidate \
  --encoder-tokenizer "$ENCODER_TOKENIZER" --chat-tokenizer "$CHAT_TOKENIZER" \
  --embed-url "$CONTENT_EMBED_URL" --encoder-id sentence-transformers/all-MiniLM-L6-v2 \
  --response-tokens 4000 --read-tokens 8000 \
  --vector-datatype float16
```

The example chooses compact float16 vector storage and candidate response budgets. It remains unqualified until retrieval measurements admit that profile; storage precision is part of the recorded index identity. Set the endpoint variables to the actual local services, with a dedicated persistent Qdrant store rather than a temporary benchmark collection.

After Appropedia acquisition finishes, prepare its permitted English-article selection using the repository's inspection receipt:

```sh
# Both figures belong to the pack being indexed and are read from its preparation
# report: footprint.by_location["content-state"] and footprint.by_location["index-storage"].
export CONTENT_STATE_RESERVE_BYTES=<content-state bytes from the preparation report>
export CONTENT_INDEX_RESERVE_BYTES=27917287424
.venv/bin/python content/tools/prepare_native.py \
  --profile "$ALMANAC_DATA/content-profile.json" --data "$ALMANAC_DATA/content-state" \
  --archive "$ALMANAC_DATA/sources/releases/appropedia-source-v1/sources/appropedia_en_all_maxi_2026-02.zim" \
  --sha256 dcf200ba723c27397e1c9a2e4891ff91fa13993df1fa285315190d8525a53469 \
  --pack-id appropedia-en-2026-02 --title "Appropedia" --publisher "Appropedia contributors" \
  --source-base-url https://www.appropedia.org --license CC-BY-SA-per-page \
  --selection-policy appropedia-open-english-v2 \
  --inspection content/inspections/appropedia-2026-02-html-v4.json \
  --content-state-reserve-bytes "$CONTENT_STATE_RESERVE_BYTES" \
  --index-storage-reserve-bytes "$CONTENT_INDEX_RESERVE_BYTES" \
  --index-storage "$ALMANAC_DATA/index/qdrant" --workers 4 \
  --embed-url "$CONTENT_EMBED_URL" --qdrant-url "$CONTENT_QDRANT_URL"
```

The build takes two reservations on two filesystems, one flag each. `--index-storage-reserve-bytes` is this build's own cap on the `--index-storage` directory: indexing halts when allocation there reaches it. `--content-state-reserve-bytes` is a free-space floor on `--data`, where the published original and this generation's article-spans artifact land: the build refuses to start, and pauses in flight, rather than exhaust that filesystem. Set each to the figure setup already computed for that location — the `footprint.by_location["index-storage"]` and `footprint.by_location["content-state"]` values in the preparation report for the pack being indexed — rather than either to the pack's whole footprint, which spans both; where a pack declares its content-state components unmeasured the report reserves nothing there, and the floor is then an operator margin for the article-spans artifact rather than a computed figure. The superseded single `--reserve-bytes` flag is refused by name, because the number it carried was the index-storage one and reusing it as the content-state floor would under-reserve the spans artifact. The 26 GiB literal above is a provisional value for the combined encyclopedia/library index and is not a corpus-size cap. Setup checks disk before downloading and this caps the build in flight; they are two different jobs and neither replaces the other. The index-storage path must identify the persistent Qdrant storage actually used by the local service. [Native corpus installation](../content/docs/native-install.md) documents the complete coverage and serving contract. The preparation command resumes interrupted work and adds a completed pack to the active library union; it does not replace other completed packs. It never treats missing inspection evidence or a partial index as successful preparation.

`--category` is optional and names the part of the library an archive is listed under, shared by the archives that belong together; the chat's library listing groups them by it. `category_titles` in `deploy/pack-catalog.json` gives the value for each catalog category. It is recorded outside the generation identity, so adding or changing one re-runs the preparation command without rebuilding the index.

The Appropedia policy applies its documented CC-BY-SA-4.0 default and explicit page licenses while respecting the checked receipt's four unresolved contrary notices. It does not require every otherwise eligible page to repeat an explicit license label. Extraction v4 preserves supported superscript, subscript and mathematical notation; historical v3 handles retain their original interpretation.

Prepare the verified complete-article Wikipedia archive with its checked-in v4 inspection receipt:

```sh
.venv/bin/python content/tools/prepare_native.py \
  --profile "$ALMANAC_DATA/content-profile.json" --data "$ALMANAC_DATA/content-state" \
  --archive "$ALMANAC_DATA/sources/releases/wikipedia-en-nopic-2026-06-source/sources/wikipedia_en_all_nopic_2026-06.zim" \
  --sha256 441a56d9e05b2d98f8ae9acb7986a513ed47904d73852c92dc6b7d50baa122e5 \
  --pack-id wikipedia-en-nopic-2026-06 --title "English Wikipedia" --publisher "Wikimedia contributors" \
  --source-base-url https://en.wikipedia.org/wiki --license CC-BY-SA-4.0 \
  --selection-policy canonical-html \
  --inspection content/inspections/wikipedia-2026-06-html-v4.json \
  --content-state-reserve-bytes "$CONTENT_STATE_RESERVE_BYTES" \
  --index-storage-reserve-bytes "$CONTENT_INDEX_RESERVE_BYTES" \
  --index-storage "$ALMANAC_DATA/index/qdrant" --workers 4 \
  --embed-url "$CONTENT_EMBED_URL" --qdrant-url "$CONTENT_QDRANT_URL"
```

Prepare CD3WD's HTML articles in the same searchable library; the complete original archive retains PDF and other source files without requiring bulk OCR:

```sh
.venv/bin/python content/tools/prepare_native.py \
  --profile "$ALMANAC_DATA/content-profile.json" --data "$ALMANAC_DATA/content-state" \
  --archive "$ALMANAC_DATA/sources/releases/cd3wd-source-v1/sources/cd3wdproject.org_en_all_2025-11.zim" \
  --sha256 f79a27413af0bd17d14adb3a556d282515a8bc1e127d791a5961c93ea9167b92 \
  --pack-id cd3wd-en-2025-11 --title "CD3WD Practical Reference Library" \
  --publisher "CD3WD collection and original publishers" \
  --source-base-url https://www.cd3wdproject.org \
  --license "Source-specific notices retained in original archive" \
  --selection-policy canonical-html \
  --inspection content/inspections/cd3wd-2025-11-html-v4.json \
  --content-state-reserve-bytes "$CONTENT_STATE_RESERVE_BYTES" \
  --index-storage-reserve-bytes "$CONTENT_INDEX_RESERVE_BYTES" \
  --index-storage "$ALMANAC_DATA/index/qdrant" --workers 4 \
  --embed-url "$CONTENT_EMBED_URL" --qdrant-url "$CONTENT_QDRANT_URL"
```

The remaining packs follow the same two steps from their own manifests in `deploy/packs/`: the complete English Project Gutenberg (`gutenberg-en-all.json`, `gutenberg-books-v1`, which indexes each book's own text rather than the scraper's cover and author pages), iFixit (`ifixit.json`, `ifixit-repair-v1`, which indexes guides, device pages and teardowns rather than member profiles), English Wikisource (`scripture-and-canon.json`, `wikisource-mainspace-v1`) and the Pali canon (`pali-canon.json`, `canonical-html`). The Survivor Library (`survivor-library.json`) is a crawl whose books are PDF scans; build its text archive with `content/tools/build_survivor_text_zim.py`, prepare that archive with `canonical-html`, and publish the crawl among the originals so that each book's source is its scan ([scanned books](../content/docs/native-install.md#scanned-books)). Write each archive's inspection receipt with `content/tools/inspect_native.py`, and read its observations before preparing.

The receipts bind the exact source hashes, v4 extraction and source-selection policies. These operations can take substantially longer than downloading a small reference pack. Keep both measured reserves and the preparation receipts when resuming them; dense vectors represent article titles/leads, while native lexical search and original reading cover complete article bodies.

With `content-profile.json` and the activated content state in the data directory, start the content service in its own terminal or supervisor:

```sh
export CONTENT_STATE_DIR="$ALMANAC_DATA/content-state"
export CONTENT_PROFILE="$ALMANAC_DATA/content-profile.json"
export CONTENT_EMBED_URL="${CONTENT_EMBED_URL:-http://127.0.0.1:8899}"
export CONTENT_QDRANT_URL="${CONTENT_QDRANT_URL:-http://127.0.0.1:26333}"
export HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1
.venv/bin/python -m oracle_content
```

For normal connected use, start [web search](web-search.md) and set `SEARXNG_BASE` for the gateway. Unavailable web search must report failure; it does not disable the installed corpus. These endpoint examples refer to separately started local services; set them to the actual ports in the selected runtime. Supply `CONTENT_RERANK_URL` only for a profile using that local reranker. The content service defaults to `127.0.0.1:8791`.

Prepare and build the selected CPU speech service while connected, using the checked-in source recipe:

```sh
export SPEECH_ASSETS="$ALMANAC_DATA/speech-assets"
.venv/bin/python speech/prepare.py "$SPEECH_ASSETS"
docker compose -f speech/compose.yaml build
docker compose -f speech/compose.yaml up -d --no-build
```

This uses the stock Alba voice and the pinned CPU dependencies in `speech/requirements.lock`. Its loopback endpoint is `ws://127.0.0.1:8793/api/tts_streaming`; [CPU speech](../speech/README.md) documents model notices and the source-only Python alternative. Speech-to-text remains a separately configured local transcription backend. These commands do not certify an exported portable image bundle.

In another terminal at the repository root, repeat the address-discovery exports from [source runtime startup](source-runtime.md#start-and-warm-transcription), then configure and start the gateway:

```sh
cd proxy
bun install --frozen-lockfile
export ALMANAC_DATA="${XDG_DATA_HOME:-$HOME/.local/share}/almanac"
export HOST=127.0.0.1 PORT=8790
export RELEASE_PROFILE="$ALMANAC_DATA/runtime-profile.json"
export CONTENT_BASE=http://127.0.0.1:8791
export VOICE_TTS_BASE=ws://127.0.0.1:8793/api/tts_streaming
export LLM_BASE="${LLM_BASE:?Repeat source-runtime address discovery in this terminal}"
export EMBED_BASE="${CONTENT_EMBED_URL:?Set the local encoder endpoint}"
export STT_BASE="${STT_BASE:?Set the local transcription endpoint}"
export FRONTEND_DIR=../dist
export QUALIFICATION_MODE=1
bun start
```

Adjust `LLM_BASE` to the selected local inference listener and configure optional speech/embedding endpoints from [the gateway environment example](../proxy/.env.example). Open `http://127.0.0.1:8790`. `QUALIFICATION_MODE=1` permits local evaluation with an explicitly unqualified candidate profile; `/v1/profile` and `/ready` retain that qualification status. Turn it off only with a qualified runtime profile and recorded receipts. Direct candidate listeners stay on loopback and must not be publicly reverse-proxied. This source route is not certification of an exported offline bundle.

## Isolated inference addressing

Do not assume a Compose `ports` declaration makes an `internal: true` network reachable through the requested host port. Qualification on Docker 29.7.1 observed a requested publication with `NetworkSettings.Ports` still null: the host port refused connections while the model's internal address answered. Setup inspects the resulting containers and reports `failed-port-publication` in that case; it preserves isolation and does not report a ready installation.

For the current isolated qualification topology, the browser gateway runs on the host and uses the model's inspected internal address. Inspect after every container recreation because the address may change:

```sh
INFERENCE_IP=$(docker inspect --format \
  '{{with index .NetworkSettings.Networks "oracle-qualification-runtime"}}{{.IPAddress}}{{end}}' \
  oracle-muse-qualification)
export LLM_BASE="http://$INFERENCE_IP:8000"
```

Those names identify the current qualification container/network; use the actual names from your selected runtime descriptor when different. Keep the host gateway on `127.0.0.1`. If the model is on a separate Linux host, read its internal address there and open an explicit local SSH forward from the browser/gateway machine:

```sh
export RUNTIME_HOST="your-linux-host"
export INFERENCE_IP="the-address-inspected-on-that-host"
ssh -N -o ControlMaster=no -o ControlPath=none -o ExitOnForwardFailure=yes \
  -L "127.0.0.1:18910:$INFERENCE_IP:8000" "$RUNTIME_HOST"
```

The dedicated SSH control settings keep the forward owned by this process and refuse a failed bind, rather than leaving a stale forward attached to a multiplexed master. In the gateway terminal use `LLM_BASE=http://127.0.0.1:18910`. This does not attach the inference container to an external network or publicly publish a qualification port. The optional all-container portable bundle remains unqualified until its actual host exposure and offline readiness are demonstrated; the working host-gateway route is the source-install path.

## Choosing the library

`deploy/pack-catalog.json` records pinned acquisition candidates with upstream hashes and exact sizes. It is not a list of cleared redistribution licenses or completed indexes. The selected Wikipedia edition is **nopic**: complete articles without images (52,690,706,555 bytes). The catalog also records maxi (127,418,087,648 bytes) as an unselected image-bearing alternative. Mini/lead-only editions do not satisfy the full-article requirement. Choose the flavour when assembling the release manifest; setup never substitutes a lead-only pack because disk is short.

Both sizes exclude semantic/lexical derivatives, model and speech weights, application images, container-image expansion, and working space. The release records `index_workspace_bytes`, `runtime_workspace_bytes` and `image_store_bytes`, each the sum of the `footprint` components itemized beneath it, so a reservation covers what installing the pack produces rather than only what it downloads. Installing a corpus pack means indexing it, and the full number is reported unabridged; `--without <component>` installs part of a pack instead, dropping that component's reservation. Every component also names the filesystem its bytes land on — the data root, the content state, the vector store or the image store — and setup checks each against that filesystem exactly once, summing whatever shares a device. Pass `--content-state` and `--index-storage` when those directories are not under `--data`; without them setup checks their components against the data root and says so in `footprint.assumed_under_data_root`. Setup reports additional required data space and checks the Docker store before downloads for an installation that will start services. Reservations sharing a filesystem are summed, including the portable export copy when its destination shares the data disk. Preparation-only and export modes do not reserve expanded container space because they do not load images. Download staging is on the data filesystem and is renamed into immutable storage, so it does not double the original's final disk requirement. Bundle export needs another full artifact copy on its destination filesystem. Final indexing elapsed time and disk use remain unmeasured; download completion alone is not retrieval readiness.


## Optional portable bundles

These bundle/export mechanics are separate from ordinary source installation and do not require the application to be air-gapped. The normal gateway can use web search while its model stays local.

When a qualified release manifest is available, export its portable bundle on a connected preparation machine:

```sh
python3 deploy/setup.py --release release.json --data /srv/local-oracle --export-bundle /media/offline/oracle-bundle
```

On the destination machine, with Python 3.10+, Docker Engine, the Compose plugin and any required GPU drivers/container integration already installed:

```sh
python3 /media/offline/oracle-bundle/setup.py --offline-bundle /media/offline/oracle-bundle --data /srv/local-oracle
```

For a connected installation without export, omit `--export-bundle`. `--prepare-only` acquires and verifies assets without touching services. Rerunning the same command resumes preparation. Setup does not invoke a package manager, obtain drivers, build containers or pull images at runtime. Offline import reads only the bundle. Host prerequisites are deliberately outside the portable application bundle and must be installed before disconnecting.

For local admission work, an explicitly labelled `qualification_candidate: true` manifest can be started with `--qualification`. This mode permits incomplete release categories and missing admission receipts, while retaining exact hashes, rights checks, image pins, offline networks and runtime download prohibitions. Every published port must bind `127.0.0.1`; after validating these boundaries setup injects `QUALIFICATION_BOUNDARY=isolated-container` only into services declaring `QUALIFICATION_MODE=1`, permitting the gateway to bind its container interface behind the loopback host publication. The declaration is an installer assertion, not independent proof by the gateway. It writes `candidate.json` with `qualification-only` and never updates production `active.json`. Candidate mode makes measurements possible without pretending those measurements already passed.

## Release manifest contract

A release JSON contains:

- `schema_version: 2`, an immutable portable `id`, and `artifacts`.
- Measured nonnegative integer `index_workspace_bytes`, `runtime_workspace_bytes`, and `image_store_bytes`, each equal to the `footprint.components` entries targeting it.
- A `footprint`, whose components each carry a distinct `name`, the `target` reservation they belong to, the `location` filesystem that holds them (`data-root`, `content-state`, `index-storage` or `image-store`), a `derivation` of `exact`, `upstream-formula`, `measured-mean` or `unmeasured`, and a `basis` naming the evidence behind the number. A quantified component also carries a `formula` and the `inputs` it consumes, and setup refuses a declared `bytes` that its own formula does not reproduce, so a hand-edited total cannot drift from the arithmetic it claims. An `unmeasured` component declares no byte count at all and is reported rather than reserved: nothing silently stands in for a quantity nobody has measured.
- Each artifact's portable relative `path`, exact positive `bytes`, `sha256`, `kind`, and HTTPS `urls`. No moving artifact identities or assumed hashes.
- Each artifact's `rights`: `acquisition` (`permitted` or `user-supplied`), `redistribution` (`permitted` only after clearance), `evidence`, and `notice`, which points to another included, hashed local artifact. Acquisition permission does not imply redistribution permission. The license file may point to itself as its notice.
- `wikipedia: {"flavour": "nopic", "path": "sources/wikipedia.zim"}` for the selected complete-article image-free release. The path must be a corpus artifact.
- `compose`, pointing to a hashed JSON Compose document, and `qualification.offline_smoke_passed`, set only after an actual disconnected-machine admission test.

Starting requires artifact kinds `application`, `image`, `model`, `tokenizer`, `speech`, `extraction`, `corpus`, `index`, and `license`. Include all runtime auxiliaries, tokenizer/template/parser assets, extraction/OCR models, installed Python/native dependencies (inside images), model shards, voice/codec assets, source files, complete derived index generations, and license/attribution records. Do not count a dependency name or source repository as an installed runtime asset. Image artifacts are saved Docker archives with an `image` reference pinned as `repository@sha256:…`; Each image artifact also carries its measured immutable `image_id`; setup verifies that ID after loading and generates effective Compose references using the ID. The original Compose retains its upstream repository digest for provenance. This avoids assuming every Docker archive/backend preserves registry RepoDigests.

Compose services use these pinned references, `pull_policy: never`, explicit internal networks and `HF_HUB_OFFLINE=1` / `TRANSFORMERS_OFFLINE=1`. Build directives and host network overrides are rejected. The service commands must refer to included local assets. The internal network prevents runtime WAN egress; online discovery is unavailable in this offline deployment. Online discovery uses the separate [SearXNG setup](web-search.md) when connected, outside the offline bundle network; model inference and the reference library remain local. Configure browser-facing ports only on loopback unless deliberately publishing the service. Bind mounts may use `${ORACLE_DATA_DIR}` and point to the prepared release/immutable data. The release's health/admission receipts, not the presence of a running container, establish application readiness.

## Integrity, interruption and portable originals

The data directory contains `objects/<sha256>`, `staging/`, `releases/<id>/` and `inventory.json`. Release files are relative symlinks to immutable originals, so a PDF, ZIM or map remains usable independently of the model. Personal browser memory is not packaged. A single setup lock prevents competing processes from overwriting a preparation job.

A transfer receipt binds URL, strong ETag, hash and byte size. Range resume requires an unchanged validator and an exact Content-Range; changed or absent validators restart the partial. Every complete file is size- and SHA-256-verified before atomic promotion. A Git LFS pointer cannot pass the binary's size/hash check. Interrupted preparation retains verified objects and records `preparing`, never `active`. Reusing a release ID for changed bytes is refused.

Export checks every artifact's redistribution status and copies the exact verified bytes and manifest into a new directory. A failed export remains labelled `.partial`; setup never promotes that directory. Keep a trusted copy of the release-manifest digest separately when moving bundles between machines: content hashes detect corruption but are not a signature or an independent trust root. On import, every artifact is checked again before services start. `active.json` records `started-not-health-verified`; the gateway/content readiness endpoints provide the separate runtime verdict.

Wikipedia article text, images, imported manuals and map assets can carry different terms. Preserve source/version/history references and local license texts; neither this application's MIT license nor inclusion in a Kiwix catalog grants rights to a book or picture. Candidates with unresolved rights stay out of distributable releases. [Wikimedia's reuse instructions](https://www.mediawiki.org/wiki/Wikimedia_APIs/Content_reuse) and [OpenStreetMap attribution](https://www.openstreetmap.org/copyright) are the primary starting points.

## Connected image materialization

A registry digest pins an OCI image but does not supply the SHA-256 or length of a Docker saved archive. Materialize those bytes on a connected preparation host with the same entry point:

```sh
python3 deploy/setup.py --materialize-images deploy/qualification-images.recipe.json --data /srv/local-oracle
```

The recipe contains `schema_version: 1` and `images`, each with a digest-pinned `image`, portable archive `path`, `rights`, `archive_reserve_bytes` and `image_store_reserve_bytes`. These are explicit conservative capacity reservations, not falsely labelled measurements of an unpulled image. Setup checks their combined requirement before pulling, rejects an image/archive that exceeds its declared reservation, records the actual archive byte size, hash and inspected image ID in `image-artifacts.json`, and stores it under `objects/<sha256>`. No service starts. When another acquisition is running on the same filesystem, pass its remaining reserved capacity as `--reserve-bytes N` so image preparation accounts for both jobs before pulling. Incorporate the resulting artifact entries and their included license notices into the immutable release manifest; registry acquisition is never performed by offline startup. Repeating materialization reuses verified saved archives.

Images do not include container writable layers or mounted volumes. Speech codec/tokenizer/model caches stored there must be separately captured, licensed, hashed and mounted from release artifacts; saving the service image alone cannot establish offline speech completeness.

## Source acquisition and native speech prerequisites

The selected CPU speech backend is [Pocket TTS with stock Alba](../speech/README.md); `deploy/packs/pocket-speech.json` pins its public assets, while `speech/Dockerfile` and `speech/requirements.lock` define the source build. The retained Orpheus manifests describe rollback artifacts and are not requirements for the selected backend.

The checked-in `deploy/packs/wikipedia-en-nopic-2026-06.json`, `appropedia.json` are source-only acquisition manifests. Use the same setup entry with `--release` and `--prepare-only`. They retain originals and component-rights notices, and their reservations cover indexing as well as acquisition, so preparation refuses a disk that the completed pack would not fit. Each pack's index components are derived from the article count the archive states in its own `M/Counter` metadata, which `content/tools/inspect_remote_zim.py` reads over range requests without acquiring the archive. Their unresolved redistribution status deliberately prevents treating those downloads as an exportable release. License/configuration text may be embedded only when its UTF-8 size and SHA-256 match its declared artifact.

`--capture-assets recipe.json` captures already installed runtime files into the object store without downloading or changing services. A private host recipe adds a `capture` field to each pinned artifact, either `{"file": "/absolute/source"}` or `{"container": "exact-container-name", "path": "/absolute/container/path"}`. Container capture dereferences the named snapshot symlink and checks bytes against the pinned upstream digest; it does not sweep a whole cache or include credentials. The portable `captured-artifacts.json` omits those host capture locations. Include its artifacts and complete notices in the eventual release. Original nanosecond modification times are preserved when copying ordinary files so immutable corpus integrity receipts survive bundle movement.

Optional pronunciation hints use a separately installed `espeak-ng` executable with matching voice/data files. The content service reports an explicit optional-capability failure when it is absent; corpus access and ordinary transcription remain available. `content/native-dependencies.json` records the upstream license/source and required distribution-package receipt. A binary-bearing content image must include its exact package version, executable/data digests, matching distribution source/patches and GPL notices; neither an upstream source link alone nor the application's MIT notice meets that package-level record. `CONTENT_ESPEAK_BIN` selects the executable; no runtime download or additional daemon is required.

For an already installed image, an image recipe may set `local_only: true` and `image_store_reserve_bytes: 0`. Setup then refuses to pull: the exact digest must already be inspectable, and only archive-copy capacity is reserved. This permits independently capturing retained speech service images without contacting a registry or assuming locally built images can be pulled elsewhere. Capture does not imply source/license redistribution clearance.

An artifact whose `urls` name a GitHub release asset rather than a Kiwix mirror has no metalink and no mirror set, so it acquires over a single connection from one address, and because a release asset can be replaced under an unchanged URL, the pinned `sha256` rather than the address is what establishes that the right bytes arrived.

For a large pack whose upstream metalink provides piece hashes, `--connections 4` enables four concurrent range requests into one staging file. The selected mirror must appear in the upstream metalink, whose whole-file size/SHA-256 must match the checked-in artifact. Each range requires the exact Content-Range and strong ETag, and each completed piece is checked against the metalink SHA-1 before its completion receipt is published; the final whole-file SHA-256 remains mandatory. Existing serial progress is renamed in place and reused only after piece verification. Interrupted parallel work resumes from its verified segment map, not from the sparse file's length. Inspect `*.segments.json` `verified_bytes` for progress. A source/validator change retains the partial but refuses reuse. The default remains one connection; the explicit parallel setting changes this acquisition only.
