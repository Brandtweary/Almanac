"""CPU stock-voice transport for the browser's 24 kHz MessagePack speech protocol."""
from __future__ import annotations

import argparse
import asyncio
import json
import logging
import os
from pathlib import Path
import queue
import threading
from urllib.parse import parse_qs, urlsplit

import msgpack
from websockets.asyncio.server import serve
from websockets.exceptions import ConnectionClosed

MAX_TEXT = 4096
MAX_FRAME = 32768
SAMPLE_RATE = 24000
logger = logging.getLogger("almanac.speech")


def read_message(raw: bytes | str) -> dict:
    if not isinstance(raw, bytes) or len(raw) > MAX_FRAME:
        raise ValueError("Expected a bounded binary MessagePack frame")
    value = msgpack.unpackb(raw, raw=False, strict_map_key=True)
    if not isinstance(value, dict) or not isinstance(value.get("type"), str) or value["type"] not in {"Text", "Eos"}:
        raise ValueError("Unsupported speech message")
    if value["type"] == "Text" and (set(value) != {"type", "text"} or not isinstance(value.get("text"), str)):
        raise ValueError("Invalid text frame")
    if value["type"] == "Eos" and set(value) != {"type"}:
        raise ValueError("Invalid end-of-input frame")
    return value


class SpeechService:
    def __init__(self, generate, timeout: float = 120):
        self.generate = generate
        self.timeout = timeout
        self.lock = asyncio.Lock()

    async def handle(self, socket):
        query = parse_qs(urlsplit(socket.request.path).query, keep_blank_values=True)
        if (urlsplit(socket.request.path).path != "/api/tts_streaming" or
            any(key not in {"voice", "format", "cfg_alpha", "auth_id"} or len(values) != 1 for key, values in query.items()) or
            query.get("voice", ["alba"]) != ["alba"] or
            query.get("format", ["PcmMessagePack"]) != ["PcmMessagePack"]):
            await socket.close(1008, "Unsupported stock voice or speech format")
            return
        if self.lock.locked():
            await socket.close(1013, "Speech busy")
            return
        async with self.lock:
            stop = threading.Event()
            worker = None
            try:
                async with asyncio.timeout(self.timeout):
                    await socket.send(msgpack.packb({"type": "Ready"}, use_bin_type=True))
                    pieces = []
                    size = 0
                    async for raw in socket:
                        message = read_message(raw)
                        if message["type"] == "Eos":
                            break
                        size += len(message["text"])
                        if size > MAX_TEXT:
                            raise ValueError("Speech text exceeds per-session limit")
                        pieces.append(message["text"])
                    else:
                        return
                    text = "".join(pieces).strip()
                    if not text:
                        await socket.close(1000, "No speech requested")
                        return
                    output = queue.Queue(maxsize=8)
                    def put(value):
                        while not stop.is_set():
                            try:
                                output.put(value, timeout=.05)
                                return
                            except queue.Full:
                                pass
                    def synthesize():
                        try:
                            for pcm in self.generate(text):
                                if stop.is_set():
                                    break
                                put(("audio", pcm))
                        except Exception:
                            logger.exception("Speech generation failed")
                            put(("error", None))
                        finally:
                            put(("done", None))
                    worker = threading.Thread(target=synthesize, name="speech-generation", daemon=True)
                    worker.start()
                    closed = asyncio.create_task(socket.wait_closed())
                    samples = 0
                    try:
                        while not closed.done():
                            try:
                                kind, value = output.get_nowait()
                            except queue.Empty:
                                await asyncio.sleep(.01)
                                continue
                            if kind == "error":
                                raise RuntimeError("Speech generation failed")
                            if kind == "done":
                                if not samples:
                                    raise RuntimeError("Speech generation returned no audio")
                                await socket.send(msgpack.packb({"type": "Text", "text": text, "start_s": 0, "stop_s": samples / SAMPLE_RATE}, use_bin_type=True))
                                await socket.close(1000, "Speech complete")
                                break
                            for start in range(0, len(value), 1920):
                                frame = value[start:start + 1920]
                                samples += len(frame)
                                await socket.send(msgpack.packb({"type": "Audio", "pcm": frame}, use_bin_type=True))
                    finally:
                        closed.cancel()
                        await asyncio.gather(closed, return_exceptions=True)
            except ConnectionClosed:
                pass
            except (ValueError, msgpack.UnpackException, TimeoutError, RuntimeError) as exc:
                await socket.close(1011, type(exc).__name__)
            finally:
                stop.set()
                # Admission remains locked until the cancelled generator really exits.
                if worker is not None:
                    await asyncio.to_thread(worker.join)


def load_generator(assets: Path, threads: int):
    from prepare import verify
    verify(assets)
    import torch
    import yaml
    import pocket_tts
    from pocket_tts import TTSModel
    torch.set_num_threads(threads)
    config = yaml.safe_load((Path(pocket_tts.__file__).parent / "config/english_2026-04.yaml").read_text(encoding="utf-8"))
    config["weights_path"] = str(assets / "model.safetensors")
    config["weights_path_without_voice_cloning"] = str(assets / "model.safetensors")
    config["flow_lm"]["lookup_table"]["tokenizer_path"] = str(assets / "tokenizer.model")
    import tempfile
    with tempfile.TemporaryDirectory(prefix="almanac-speech-config-") as folder:
        path = Path(folder) / "config.yaml"
        path.write_text(yaml.safe_dump(config), encoding="utf-8")
        model = TTSModel.load_model(config=str(path))
    voice = model.get_state_for_audio_prompt(str(assets / "alba.safetensors"))
    if model.sample_rate != SAMPLE_RATE:
        raise RuntimeError("The browser requires 24 kHz audio")
    def generate(text):
        for chunk in model.generate_audio_stream(voice, text):
            yield chunk.detach().cpu().reshape(-1).tolist()
    return generate


async def run(args):
    service = SpeechService(load_generator(args.assets.resolve(), args.threads))
    async def health(connection, request):
        if request.path == "/health":
            return connection.respond(200, json.dumps({"ready": True, "busy": service.lock.locked(), "engine": "pocket-tts", "voice": "alba", "sample_rate": SAMPLE_RATE, "device": "cpu"}))
    async with serve(service.handle, args.host, args.port, max_size=MAX_FRAME, max_queue=8, write_limit=65536, process_request=health):
        logger.info("CPU speech ready on %s:%s", args.host, args.port)
        await asyncio.Future()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--assets", type=Path, required=True)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8793)
    parser.add_argument("--threads", type=int, default=2)
    args = parser.parse_args()
    if args.threads < 1:
        parser.error("threads must be positive")
    os.environ["HF_HUB_OFFLINE"] = "1"
    os.environ["CUDA_VISIBLE_DEVICES"] = ""
    logging.basicConfig(level=logging.INFO)
    asyncio.run(run(args))
