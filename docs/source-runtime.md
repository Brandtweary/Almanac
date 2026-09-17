# Source runtime startup

Run these commands from the cloned repository root, after the package/build steps in [installation](install.md#source-based-local-setup). They acquire and start the selected components directly; they do not require an absent portable release manifest. The language-model configuration targets the measured Linux, NVIDIA 32 GB GPU setup. Install Docker Engine, the NVIDIA Container Toolkit, Python 3.11+ and `curl` during connected preparation. Check existing container names and service allocations first; these commands refuse name collisions rather than replacing another installation.

The selected model snapshot alone is 24,698,225,080 bytes. Add complete reference originals, image storage, writable model caches and the index reservation before acquisition. The full nopic original is 52,690,706,555 bytes; the current compact corpus reservation is a provisional 26 GiB. No command silently reduces context or substitutes a smaller library to fit the machine.

## Acquire exact model files while connected

The script below uses the existing installer's resumable transfer and checksum verification. The chat snapshot's filenames, URLs, sizes and hashes come directly from its checked-in descriptor, including its license/model-card files. Encoder pins reproduce the inspected CPU service's ONNX snapshot at revision `1110a243fdf4706b3f48f1d95db1a4f5529b4d41`; these are the files its existing deployment actually uses. Transcription pins come from the retained speech manifest, selecting only its transcription model.

```sh
export ALMANAC_DATA="${XDG_DATA_HOME:-$HOME/.local/share}/almanac"
mkdir -p "$ALMANAC_DATA"
python3 - <<'PY'
import importlib.util, json, os, shutil
from pathlib import Path

spec = importlib.util.spec_from_file_location("almanac_setup", "deploy/setup.py")
setup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(setup)
root = Path(os.environ["ALMANAC_DATA"]).resolve()
staging = root / "model-staging"
staging.mkdir(parents=True, exist_ok=True)
runtime = json.loads(Path("deploy/muse-glimmer-vllm-candidate.json").read_text())
encoder_revision = "1110a243fdf4706b3f48f1d95db1a4f5529b4d41"
encoder_files = [
    ("config.json", 612, "953f9c0d463486b10a6871cc2fd59f223b2c70184f49815e7efbcab5d8908b41"),
    ("config_sentence_transformers.json", 116, "061ca9d39661d6c6d6de5ba27f79a1cd5770ea247f8d46412a68a498dc5ac9f3"),
    ("sentence_bert_config.json", 53, "fc1993fde0a95c24ec6c022539d41cf6e2f7c9721e5415d6fb6897472a9cd4b7"),
    ("tokenizer.json", 466247, "be50c3628f2bf5bb5e3a7f17b1f74611b2561a3a27eeab05e5aa30f411572037"),
    ("tokenizer_config.json", 350, "acb92769e8195aabd29b7b2137a9e6d6e25c476a4f15aa4355c233426c61576b"),
    ("1_Pooling/config.json", 190, "4be450dde3b0273bb9787637cfbd28fe04a7ba6ab9d36ac48e92b11e350ffc23"),
    ("onnx/model.onnx", 90405214, "6fd5d72fe4589f189f8ebc006442dbb529bb7ce38f8082112682524616046452"),
]
encoder = [{"path": path, "bytes": size, "sha256": sha,
            "url": f"https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2/resolve/{encoder_revision}/{path}"}
           for path, size, sha in encoder_files]
speech = json.loads(Path("deploy/speech-candidates.json").read_text())["artifacts"]
transcription = [dict(row, path=row["filename"]) for row in speech
                 if row["source"] == "Systran/faster-distil-whisper-large-v3"]
groups = [("chat", runtime["files"]), ("encoder", encoder), ("transcription", transcription)]
needed = sum(row["bytes"] for group, rows in groups for row in rows
             if not setup.verify(root / "models" / group / row["path"], row))
if shutil.disk_usage(root).free < needed:
    raise SystemExit(f"Insufficient space for remaining model originals: {needed} bytes")
for group, rows in groups:
    for row in rows:
        destination = root / "models" / group / setup.relative(row["path"])
        destination.parent.mkdir(parents=True, exist_ok=True)
        artifact = dict(row, urls=[row["url"]])
        if not setup.verify(destination, artifact):
            setup.transfer(artifact, staging).replace(destination)
    print(f"Verified {group} files", flush=True)
PY
```

Run this acquisition only once per data directory at a time. Its free-space check covers remaining model originals; retain the separate corpus/image/workspace reservations. Existing verified files are reused. The encoder's [upstream model card and license](https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2/tree/1110a243fdf4706b3f48f1d95db1a4f5529b4d41), transcription source notices and dependency notices remain necessary for redistribution; this source acquisition is not a redistributable-bundle license grant.

Pull the exact serving images during connected preparation:

```sh
export INFERENCE_IMAGE=$(python3 -c 'import json; print(json.load(open("deploy/muse-glimmer-vllm-candidate.json"))["serving"]["image"])')
export EMBED_IMAGE=ghcr.io/huggingface/text-embeddings-inference@sha256:7f8cbd5fbf27d1ad82450b68ec37e542bbfb0d03e6dc79d6d00242022f2fc4c7
export QDRANT_IMAGE=qdrant/qdrant@sha256:12364fe851b9f17356fc88189fc06d1b521262e04659ec7345975b00c9246a10
export TRANSCRIPTION_IMAGE=fedirz/faster-whisper-server@sha256:0b64050ad0b9244745746b652473ee42a8d5454d501877a252c3e65f631ffc99
for image in "$INFERENCE_IMAGE" "$EMBED_IMAGE" "$QDRANT_IMAGE" "$TRANSCRIPTION_IMAGE"; do
  docker pull "$image" || exit 1
done
```

## Start the isolated model and persistent auxiliaries

These backend services use an internal Docker network and no published container ports. The application gateway can still use normal [web search](web-search.md); the backend boundary keeps local inference separate from that online tool and is not an application air-gap requirement. The host can reach their inspected internal addresses. This avoids the measured Docker configuration where an internal network silently ignored requested host-port publication. Keep the browser gateway and content service on host loopback; do not attach inference to an external network to work around addressing.

```sh
export ALMANAC_NETWORK=oracle-qualification-runtime
if ! docker network inspect "$ALMANAC_NETWORK" >/dev/null 2>&1; then
  docker network create --internal "$ALMANAC_NETWORK"
fi
test "$(docker network inspect --format '{{.Internal}}' "$ALMANAC_NETWORK")" = true
mkdir -p "$ALMANAC_DATA/runtime-cache" "$ALMANAC_DATA/index/qdrant" "$ALMANAC_DATA/index/snapshots"
```

Start inference using the descriptor's exact tested argument vector, without retyping a shorter context or changing its attention/cache settings:

```sh
python3 - <<'PY'
import json, os, subprocess
from pathlib import Path
root = Path(os.environ["ALMANAC_DATA"]).resolve()
descriptor = json.loads(Path("deploy/muse-glimmer-vllm-candidate.json").read_text())
configuration = descriptor["proposed_measurement"]
assert configuration["context_tokens"] == 131072
args = ["docker", "run", "--detach", "--name", "oracle-muse-qualification",
        "--pull", "never", "--gpus", "all", "--network", os.environ["ALMANAC_NETWORK"],
        "--shm-size", "4g", "--volume", str(root / "models/chat") + ":/model:ro",
        "--volume", str(root / "runtime-cache") + ":/cache"]
environment = {**configuration["environment"], "VLLM_NO_USAGE_STATS": "1",
               "XDG_CACHE_HOME": "/cache", "VLLM_CACHE_ROOT": "/cache/vllm",
               "CUDA_CACHE_PATH": "/cache/cuda"}
for key, value in environment.items():
    args += ["--env", key + "=" + value]
subprocess.run([*args, descriptor["serving"]["image"], *configuration["command"]], check=True)
PY
```

The descriptor records 131,072 context tokens, one sequence, BF16 KV (`auto` for this model), 2,415,919,104 cache bytes, `FLASH_ATTN`, the pinned chat template, a single decode graph and the selected sampling settings. Its full-window configuration was measured with CPU speech and CUDA transcription on the target GPU. The [recorded local runtime measurements](../results/local-runtime.md) state the tested scope and limitations. Hardware-dependent admission and complete release certification remain separate; an allocation failure must stay visible rather than silently cutting context.

Start the CPU encoder from the verified local snapshot and give Qdrant dedicated persistent storage:

```sh
docker run --detach --name almanac-encoder --pull never \
  --network "$ALMANAC_NETWORK" \
  --env HF_HUB_OFFLINE=1 --env TRANSFORMERS_OFFLINE=1 \
  --volume "$ALMANAC_DATA/models/encoder:/model:ro" \
  "$EMBED_IMAGE" --model-id /model --revision 1110a243fdf4706b3f48f1d95db1a4f5529b4d41

docker run --detach --name almanac-content-qdrant --pull never \
  --user "$(id -u):$(id -g)" --restart unless-stopped --memory 4g --cpus 4 \
  --network "$ALMANAC_NETWORK" \
  --volume "$ALMANAC_DATA/index/qdrant:/qdrant/storage" \
  --volume "$ALMANAC_DATA/index/snapshots:/qdrant/snapshots" \
  "$QDRANT_IMAGE"
```

This local-directory TEI recipe passed a fresh CPU smoke with the exact seven verified files, the pinned image, networking disabled, one CPU and 2 GiB RAM: startup took 2.079 seconds and one finite 384-dimensional embedding took 0.158 seconds. This validates the encoder startup path, not a whole-machine offline installation. In local-directory mode, `/info` reports `/model` as runtime identity and the pinned revision as model identity. When creating the content profile, supply `--encoder-id sentence-transformers/all-MiniLM-L6-v2` so the portable model identity remains distinct from its container mount. Do not point the library at a temporary benchmark Qdrant directory.

## Start and warm transcription

The retained transcription image contains its Python environment; use that environment directly rather than allowing `uv run` to synchronize dependencies during startup. Its server configuration accepts a local model directory and uses it when the client does not name another model:

```sh
docker run --detach --name almanac-transcription --pull never --gpus all \
  --network "$ALMANAC_NETWORK" \
  --env HF_HUB_OFFLINE=1 --env TRANSFORMERS_OFFLINE=1 \
  --env WHISPER__MODEL=/model --env WHISPER__INFERENCE_DEVICE=cuda \
  --env WHISPER__TTL=-1 --env UVICORN_HOST=0.0.0.0 --env UVICORN_PORT=8000 \
  --volume "$ALMANAC_DATA/models/transcription:/model:ro" \
  --entrypoint /root/faster-whisper-server/.venv/bin/python \
  "$TRANSCRIPTION_IMAGE" -m uvicorn --factory faster_whisper_server.main:create_app
```

Discover the actual addresses and export the endpoints used by the host services:

```sh
container_ip() {
  docker inspect --format '{{with index .NetworkSettings.Networks "oracle-qualification-runtime"}}{{.IPAddress}}{{end}}' "$1"
}
export LLM_BASE="http://$(container_ip oracle-muse-qualification):8000"
export CONTENT_EMBED_URL="http://$(container_ip almanac-encoder):80"
export EMBED_BASE="$CONTENT_EMBED_URL"
export CONTENT_QDRANT_URL="http://$(container_ip almanac-content-qdrant):6333"
export STT_BASE="http://$(container_ip almanac-transcription):8000"
printf '%s\n' "$LLM_BASE" "$CONTENT_EMBED_URL" "$CONTENT_QDRANT_URL" "$STT_BASE"
```

Inspect model startup logs if a service is not healthy. A successful process start is not model readiness:

```sh
curl --fail "$LLM_BASE/health"
curl --fail "$CONTENT_EMBED_URL/health"
curl --fail "$CONTENT_EMBED_URL/info"
curl --fail "$CONTENT_QDRANT_URL/readyz"
curl --fail "$STT_BASE/health"
```

Transcription loads its weights on an actual request; the process health endpoint alone does not prove residency. A local silence WAV supplies a reproducible warmup without a private recording:

```sh
python3 - <<'PY'
import os, wave
from pathlib import Path
path = Path(os.environ["ALMANAC_DATA"]) / "transcription-warmup.wav"
with wave.open(str(path), "wb") as output:
    output.setnchannels(1)
    output.setsampwidth(2)
    output.setframerate(16000)
    output.writeframes(bytes(32000))
PY
curl --fail -F "file=@$ALMANAC_DATA/transcription-warmup.wav" "$STT_BASE/v1/audio/transcriptions"
```

The gateway supplies transcription only after the local backend is available. CPU Pocket TTS uses the separate [checked-in speech source recipe](../speech/README.md); configure `VOICE_TTS_BASE=ws://127.0.0.1:8793/api/tts_streaming` after starting it.

## Continue with the application

For connected discovery, start the documented SearXNG service and export `SEARXNG_BASE=http://127.0.0.1:8888` to the host gateway. A missing internet connection leaves that tool explicitly unavailable while the installed library remains usable. Keep the exported endpoint variables in the shell used for profile creation and content startup. Set `ENCODER_TOKENIZER="$ALMANAC_DATA/models/encoder/tokenizer.json"` and `CHAT_TOKENIZER="$ALMANAC_DATA/models/chat/tokenizer.json"`, then continue with [profile creation and native corpus preparation](install.md#source-based-local-setup). Start the gateway with the exported `LLM_BASE`, `EMBED_BASE` and `STT_BASE`, and the selected CPU speech endpoint. In a new terminal, repeat address discovery instead of copying addresses from an earlier container incarnation.

For a model on another machine, use the [dedicated SSH loopback forward](install.md#isolated-inference-addressing); the public browser entry belongs to the host gateway, never the isolated inference listener. These source commands establish an inspectable local installation path. They do not assert that a portable image bundle, every host platform or all corpus indexes are already qualified.
