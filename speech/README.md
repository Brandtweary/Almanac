# CPU speech

Pocket TTS with the public stock Alba preset is the application's CPU speech backend. The service adapts the published [Kyutai engine](https://github.com/kyutai-labs/pocket-tts) to the existing browser MessagePack protocol; it has no user voice-upload or arbitrary URL surface. Alba is reference-conditioned from a public voice-actor recording, not an originally designed voice. The browser defaults to `alba`, with `VITE_TTS_VOICE` available for deployments using another compatible backend.

## Preparation and startup

`assets.json` pins the public non-cloning model, tokenizer and Alba state by upstream revision, length and SHA-256. Acquisition is separate from offline serving:

```sh
python speech/prepare.py /path/to/speech-assets
python -m venv /path/to/speech-venv
/path/to/speech-venv/bin/pip install --require-hashes --extra-index-url https://download.pytorch.org/whl/cpu -r speech/requirements.lock
/path/to/speech-venv/bin/python speech/server.py --assets /path/to/speech-assets
```

The source Docker recipe is `speech/Dockerfile`; `speech/compose.yaml` mounts verified assets read-only and exposes loopback port 8793. Set the gateway's `VOICE_TTS_BASE` to `ws://<speech-service>:8793/api/tts_streaming`. CPU-only Torch is explicitly pinned; the service has no GPU reservation. The base image is pinned by digest. Release assembly must build/export the image and include its measured image and asset receipts through the existing setup manifest. A recipe alone is not an offline-ready release.

Startup requires all assets locally and disables model-hub network access. `GET /health` reports service readiness after initial model/voice loading, with `workerLoaded` distinguishing a warm worker from one awaiting lazy reload. The only synthesis path is `/api/tts_streaming?voice=alba&format=PcmMessagePack`. `cfg_alpha` is accepted for compatibility but does not change Pocket's sampling configuration.

The browser streams link labels into speech while excluding link destinations and corpus handles before sentence chunking; written responses and their citations remain intact.

Each connection receives `Ready`, accumulates bounded `Text` frames, and begins generation at `Eos`; the browser already supplies sentence-sized sessions. Audio streams as 24 kHz mono float PCM `Audio` frames, followed by a `Text` timing receipt and normal close. A failure closes abnormally. One generation owns the engine at a time; busy clients receive 1013. Synthesis runs in a persistent spawned process; disconnect, deadline expiry or failure kills and reaps that worker before admission is released, and the next request loads a fresh engine. Queued audio, frame size, text length and session lifetime are bounded.

## Tests and measurements

Run hermetic tests with `python -m unittest discover -s speech -p 'test_*.py'`. The explicit integration probe is `python speech/smoke.py ws://127.0.0.1:8793/api/tts_streaming?voice=alba`.

A CPU-only development measurement on a virtualized x86 host with two synthesis threads produced first audio in 207–237 ms, generated 5.6–5.76 seconds of speech in 2.45–2.53 seconds, and used about 1.01 GiB peak RSS. These are host-specific observations, not release performance guarantees or a perceptual comparison with other voices. Context qualification must measure simultaneous chat inference, transcription, speech and retrieval.

## Upstream rights and attribution

Pocket TTS source is [MIT licensed](https://github.com/kyutai-labs/pocket-tts/blob/main/LICENSE). The [public non-cloning model](https://huggingface.co/kyutai/pocket-tts-without-voice-cloning) identifies CC-BY-4.0; retain its attribution and model card with the shipped artifacts. Alba's source-voice rights are described in [Kyutai's public voice catalog](https://huggingface.co/kyutai/tts-voices). Local notices accompany this directory. These component licenses remain distinct from the application license. Only public upstream stock assets are included; no private voice recordings or presets are dependencies.
