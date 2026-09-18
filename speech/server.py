"""CPU stock-voice transport for the browser's 24 kHz MessagePack speech protocol."""
from __future__ import annotations

import argparse
import asyncio
import json
import logging
import os
from pathlib import Path
import queue
import multiprocessing
from functools import partial
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


def synthesis_worker(factory, requests, output, cancel):
    try:
        generate = factory()
        output.put(("ready", None))
        while True:
            text = requests.get()
            abandoned = False
            for pcm in generate(text):
                # Bound the queue in audio frames, not model-sized chunks.
                for start in range(0, len(pcm), 1920):
                    # A put that blocks forever on an undrained queue is why an
                    # abandoned session used to cost a process kill and a model
                    # reload; the timeout is what makes cancellation possible.
                    while not abandoned:
                        try:
                            output.put(("audio", pcm[start:start + 1920]), timeout=.1)
                            break
                        except queue.Full:
                            abandoned = cancel.is_set()
                    if abandoned:
                        break
                if abandoned or cancel.is_set():
                    abandoned = True
                    break
            output.put(("cancelled" if abandoned else "done", None))
    except Exception:
        logger.exception("Speech generation failed")
        output.put(("error", None))


class SpeechService:
    def __init__(self, factory, timeout: float = 120, reset_timeout: float = 2):
        self.factory = factory
        self.worker = None
        self.requests = None
        self.output = None
        self.cancel = None
        self.timeout = timeout
        # How long a worker has to acknowledge cancellation before it is killed
        # instead. One generation chunk is the unit; an unresponsive worker is
        # still reaped, it just no longer costs a reload in the ordinary case.
        self.reset_timeout = reset_timeout
        self.lock = asyncio.Lock()

    async def receive(self):
        while True:
            try:
                return self.output.get_nowait()
            except queue.Empty:
                if not self.worker.is_alive():
                    raise RuntimeError("Speech worker exited")
                await asyncio.sleep(.01)

    async def start(self):
        if self.worker is not None:
            if self.worker.is_alive():
                return
            await self.close()
        ctx = multiprocessing.get_context("spawn")
        self.requests = ctx.Queue(maxsize=1)
        self.output = ctx.Queue(maxsize=8)
        self.cancel = ctx.Event()
        self.worker = ctx.Process(target=synthesis_worker,
            args=(self.factory, self.requests, self.output, self.cancel), daemon=True)
        self.worker.start()
        if (await self.receive())[0] != "ready":
            raise RuntimeError("Speech worker initialization failed")

    async def uninterruptible(self, operation):
        """Reaping and recovery own native resources and never half-complete."""
        task = asyncio.create_task(operation())
        cancelled = False
        while not task.done():
            try:
                await asyncio.shield(task)
            except asyncio.CancelledError:
                cancelled = True
        task.result()
        if cancelled:
            raise asyncio.CancelledError

    async def reap(self):
        worker = self.worker
        if worker is not None:
            if worker.is_alive():
                worker.kill()
            while worker.is_alive():
                await asyncio.sleep(.01)
            if worker.pid is not None:
                worker.join()
            worker.close()
            self.worker = None
        for channel in (self.requests, self.output):
            if channel is not None:
                channel.cancel_join_thread()
                channel.close()
        self.requests = self.output = self.cancel = None

    async def close(self):
        await self.uninterruptible(self.reap)

    async def recover(self):
        """Return an abandoned session's worker to idle without a model reload."""
        if self.worker is None or not self.worker.is_alive():
            return await self.reap()
        self.cancel.set()
        try:
            async with asyncio.timeout(self.reset_timeout):
                while True:
                    kind, _value = await self.receive()
                    if kind in {"done", "cancelled"}:
                        return
                    if kind == "error":
                        return await self.reap()
        except (TimeoutError, RuntimeError):
            # A worker that will not acknowledge cancellation is reaped as before.
            return await self.reap()
        finally:
            if self.cancel is not None:
                self.cancel.clear()

    async def reset(self):
        await self.uninterruptible(self.recover)

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
            complete = False
            engaged = False
            synthesizing = False
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
                    closed = asyncio.create_task(socket.wait_closed())
                    engaged = True
                    startup = asyncio.create_task(self.start())
                    samples = 0
                    try:
                        await asyncio.wait((startup, closed), return_when=asyncio.FIRST_COMPLETED)
                        if closed.done():
                            return
                        await startup
                        self.requests.put_nowait(text)
                        synthesizing = True
                        while not closed.done():
                            try:
                                kind, value = self.output.get_nowait()
                            except queue.Empty:
                                if not self.worker.is_alive():
                                    raise RuntimeError("Speech worker exited")
                                await asyncio.sleep(.01)
                                continue
                            if kind == "error":
                                raise RuntimeError("Speech generation failed")
                            if kind == "done":
                                if not samples:
                                    raise RuntimeError("Speech generation returned no audio")
                                await socket.send(msgpack.packb({"type": "Text", "text": text, "start_s": 0, "stop_s": samples / SAMPLE_RATE}, use_bin_type=True))
                                await socket.close(1000, "Speech complete")
                                complete = True
                                break
                            for start in range(0, len(value), 1920):
                                frame = value[start:start + 1920]
                                samples += len(frame)
                                await socket.send(msgpack.packb({"type": "Audio", "pcm": frame}, use_bin_type=True))
                    finally:
                        startup.cancel()
                        closed.cancel()
                        await asyncio.gather(startup, closed, return_exceptions=True)
            except ConnectionClosed:
                pass
            except (ValueError, msgpack.UnpackException, TimeoutError, RuntimeError) as exc:
                await socket.close(1011, type(exc).__name__)
            finally:
                if engaged and not complete:
                    # Abandoned sessions are the common case — barge-in, mute, a
                    # new chat. Native work still finishes before admission is
                    # released, but a worker that is mid-generation is cancelled
                    # rather than killed, so the next sentence needs no reload.
                    # A worker still loading its model has nothing to cancel.
                    await (self.reset() if synthesizing else self.close())


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
    service = SpeechService(partial(load_generator, args.assets.resolve(), args.threads))
    try:
        async with asyncio.timeout(120):
            await service.start()
    except BaseException:
        await service.close()
        raise
    async def health(connection, request):
        if request.path == "/health":
            worker_loaded = service.worker is not None and service.worker.is_alive()
            return connection.respond(200, json.dumps({"ready": True, "workerLoaded": worker_loaded, "busy": service.lock.locked(), "engine": "pocket-tts", "voice": "alba", "sample_rate": SAMPLE_RATE, "device": "cpu"}))
    try:
        async with serve(service.handle, args.host, args.port, max_size=MAX_FRAME, max_queue=8, write_limit=65536, process_request=health):
            logger.info("CPU speech ready on %s:%s", args.host, args.port)
            await asyncio.Future()
    finally:
        await service.close()



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
