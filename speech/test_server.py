"""Hermetic transport tests; model generation and sockets are disposable fixtures."""
import asyncio
import threading
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


class TransportTests(unittest.IsolatedAsyncioTestCase):
    async def test_chunked_audio_and_timing(self):
        seen = []
        def generate(text):
            seen.append(text)
            yield [.25] * 2400
        service = SpeechService(generate)
        socket = Socket([packed({"type":"Text","text":"Hello "}),packed({"type":"Text","text":"world."}),packed({"type":"Eos"})])
        await service.handle(socket)
        self.assertEqual(seen, ["Hello world."])
        self.assertEqual(socket.sent[0], {"type":"Ready"})
        self.assertEqual([len(x["pcm"]) for x in socket.sent if x["type"] == "Audio"], [1920,480])
        self.assertEqual(socket.sent[-1]["stop_s"], .1)
        self.assertEqual(socket.code,1000)

    async def test_invalid_or_oversized_text_never_generates(self):
        for frames in [[packed({"type":"Voice","audio":"private"})], [packed({"type":"Text","text":"x"*(MAX_TEXT+1)}),packed({"type":"Eos"})]]:
            service=SpeechService(lambda _: self.fail("Rejected input reached generation"))
            socket=Socket(frames)
            await service.handle(socket)
            self.assertEqual(socket.code,1011)
        for path in ["/api/tts_streaming?voice=https://example.invalid/audio.wav", "/api/tts_streaming?voice=alba&voice=other"]:
            socket=Socket([],path);await service.handle(socket);self.assertEqual(socket.code,1008)

    async def test_disconnect_releases_only_after_worker_exit(self):
        entered=threading.Event();release=threading.Event();exited=threading.Event()
        def generate(_):
            try:
                entered.set();release.wait();yield [.1]*1920
            finally:
                exited.set()
        service=SpeechService(generate)
        socket=Socket([packed({"type":"Text","text":"Hello."}),packed({"type":"Eos"})])
        task=asyncio.create_task(service.handle(socket))
        while not entered.is_set():await asyncio.sleep(.001)
        socket.closed.set()
        await asyncio.sleep(.02)
        self.assertTrue(service.lock.locked())
        other=Socket([]);await service.handle(other);self.assertEqual(other.code,1013)
        release.set();await asyncio.wait_for(task,2)
        self.assertTrue(exited.is_set());self.assertFalse(service.lock.locked())
        again=Socket([packed({"type":"Eos"})]);await service.handle(again);self.assertEqual(again.code,1000)

    async def test_timeout_waits_for_generation_to_exit(self):
        entered=threading.Event();release=threading.Event()
        def generate(_):
            entered.set();release.wait();yield [.1]*1920
        service=SpeechService(generate,timeout=.02)
        socket=Socket([packed({"type":"Text","text":"Hello."}),packed({"type":"Eos"})])
        task=asyncio.create_task(service.handle(socket))
        while not entered.is_set():await asyncio.sleep(.001)
        await asyncio.sleep(.04)
        self.assertEqual(socket.code,1011)
        self.assertTrue(service.lock.locked())
        release.set();await asyncio.wait_for(task,2)
        self.assertFalse(service.lock.locked())

    async def test_generator_failure_is_visible(self):
        def generate(_):
            raise RuntimeError("fixture failure")
            yield []
        socket=Socket([packed({"type":"Text","text":"Hello."}),packed({"type":"Eos"})])
        with self.assertLogs("almanac.speech",level="ERROR"):
            await SpeechService(generate).handle(socket)
        self.assertEqual(socket.code,1011)

    def test_text_frames_cannot_smuggle_extra_fields(self):
        with self.assertRaises(ValueError):read_message(packed({"type":"Text","text":"Hello","voice_url":"x"}))
        with self.assertRaises(ValueError):read_message('not binary')


if __name__ == "__main__":
    unittest.main()
