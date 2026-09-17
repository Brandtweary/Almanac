"""Hermetic transport tests; model generation and sockets are disposable fixtures."""
import asyncio
import os
import time
import unittest
from types import SimpleNamespace
import msgpack
from server import SpeechService, read_message, MAX_TEXT


def packed(value):
    return msgpack.packb(value, use_bin_type=True)


class Socket:
    def __init__(self, messages, path="/api/tts_streaming?voice=alba&format=PcmMessagePack"):
        self.request = SimpleNamespace(path=path)
        self.messages = list(messages)
        self.sent = []
        self.closed = asyncio.Event()
        self.code = None
        self.disconnect_on_audio = False
    def __aiter__(self):
        return self
    async def __anext__(self):
        if not self.messages:
            raise StopAsyncIteration
        return self.messages.pop(0)
    async def send(self, data):
        decoded = msgpack.unpackb(data, raw=False)
        self.sent.append(decoded)
        if self.disconnect_on_audio and decoded["type"] == "Audio":
            self.closed.set()
    async def close(self, code, reason):
        self.code = code
        self.closed.set()
    async def wait_closed(self):
        await self.closed.wait()


def blocked_factory():
    while True:
        time.sleep(1)


def fixture_factory():
    def generate(text):
        if text == "block":
            while True:
                time.sleep(1)
        if text == "fail":
            raise RuntimeError("fixture failure")
        yield [.25] * 2400
    return generate


class TransportTests(unittest.IsolatedAsyncioTestCase):
    async def test_chunked_audio_and_timing(self):
        service = SpeechService(fixture_factory)
        self.addAsyncCleanup(service.close)
        socket = Socket([packed({"type":"Text","text":"Hello "}),packed({"type":"Text","text":"world."}),packed({"type":"Eos"})])
        await service.handle(socket)
        self.assertEqual(socket.sent[0], {"type":"Ready"})
        self.assertEqual([len(x["pcm"]) for x in socket.sent if x["type"] == "Audio"], [1920,480])
        self.assertEqual(socket.sent[-1]["stop_s"], .1)
        self.assertEqual(socket.code,1000)

    async def test_invalid_or_oversized_text_never_generates(self):
        for frames in [[packed({"type":"Voice","audio":"private"})], [packed({"type":"Text","text":"x"*(MAX_TEXT+1)}),packed({"type":"Eos"})]]:
            service=SpeechService(fixture_factory)
            socket=Socket(frames)
            await service.handle(socket)
            self.assertEqual(socket.code,1011)
        for path in ["/api/tts_streaming?voice=https://example.invalid/audio.wav", "/api/tts_streaming?voice=alba&voice=other"]:
            socket=Socket([],path);await service.handle(socket);self.assertEqual(socket.code,1008)

    async def test_blocked_worker_is_reaped_and_admission_recovers(self):
        for reason in ("disconnect", "timeout", "cancel"):
            service = SpeechService(fixture_factory)
            self.addAsyncCleanup(service.close)
            await service.start()
            pid = service.worker.pid
            if reason == "timeout":
                service.timeout = .05
            socket = Socket([packed({"type":"Text","text":"block"}), packed({"type":"Eos"})])
            task = asyncio.create_task(service.handle(socket))
            await asyncio.sleep(.02)
            if reason == "disconnect":
                socket.closed.set()
            elif reason == "cancel":
                task.cancel()
                await asyncio.sleep(0)
                task.cancel()
            try:
                await asyncio.wait_for(task, 2)
            except asyncio.CancelledError:
                self.assertEqual(reason, "cancel")
            self.assertFalse(service.lock.locked())
            self.assertIsNone(service.worker)
            with self.assertRaises(ProcessLookupError):
                os.kill(pid, 0)
            service.timeout = 5
            again = Socket([packed({"type":"Text","text":"Hello"}), packed({"type":"Eos"})])
            await service.handle(again)
            self.assertEqual(again.code, 1000)
            await service.close()

    async def test_disconnect_during_initialization_reaps_worker(self):
        service = SpeechService(blocked_factory)
        self.addAsyncCleanup(service.close)
        socket = Socket([packed({"type":"Text","text":"Hello"}), packed({"type":"Eos"})])
        task = asyncio.create_task(service.handle(socket))
        while service.worker is None:
            await asyncio.sleep(.001)
        pid = service.worker.pid
        socket.closed.set()
        await asyncio.wait_for(task, 2)
        self.assertIsNone(service.worker)
        self.assertFalse(service.lock.locked())
        with self.assertRaises(ProcessLookupError):
            os.kill(pid, 0)

    async def test_generator_failure_is_visible(self):
        service = SpeechService(fixture_factory)
        self.addAsyncCleanup(service.close)
        socket=Socket([packed({"type":"Text","text":"fail"}),packed({"type":"Eos"})])
        await service.handle(socket)
        self.assertEqual(socket.code,1011)
        self.assertIsNone(service.worker)

    async def test_empty_invalid_and_pre_synthesis_disconnect_preserve_warm_worker(self):
        service = SpeechService(fixture_factory)
        self.addAsyncCleanup(service.close)
        await service.start()
        worker = service.worker
        for frames in ([packed({"type":"Eos"})], [packed({"type":"Wrong"})], []):
            socket = Socket(frames)
            await service.handle(socket)
            self.assertIs(service.worker, worker)
            self.assertTrue(worker.is_alive())

    async def test_busy_client_cannot_reuse_worker(self):
        service = SpeechService(fixture_factory)
        async with service.lock:
            socket = Socket([])
            await service.handle(socket)
            self.assertEqual(socket.code, 1013)

    def test_text_frames_cannot_smuggle_extra_fields(self):
        with self.assertRaises(ValueError):read_message(packed({"type":"Text","text":"Hello","voice_url":"x"}))
        with self.assertRaises(ValueError):read_message('not binary')


if __name__ == "__main__":
    unittest.main()
