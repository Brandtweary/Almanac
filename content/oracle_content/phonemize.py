"""Stateless bounded native IPA conversion; personal text never enters a log or cache."""
from __future__ import annotations
import asyncio
import json
import os
import re
import shutil
import signal
import unicodedata
from typing import Annotated, Literal
from pydantic import Field, StringConstraints, field_validator
from .models import ContentError, Strict

MAX_TEXTS = 256
MAX_TEXT_CHARACTERS = 64
MAX_REQUEST_BYTES = 131072
MAX_OUTPUT_BYTES = 16384


class PhonemizeRequest(Strict):
    texts: list[Annotated[str, StringConstraints(strict=True, min_length=1, max_length=MAX_TEXT_CHARACTERS,
                                                 )]] = Field(max_length=MAX_TEXTS)
    language: Literal["en-us"]

    @field_validator("texts", mode="before")
    @classmethod
    def normalize_text(cls, texts):
        if isinstance(texts, list):
            return [unicodedata.normalize("NFC", text) if isinstance(text, str) else text for text in texts]
        return texts

    @field_validator("texts")
    @classmethod
    def nonempty_text(cls, texts):
        for text in texts:
            categories = [unicodedata.category(character)[0] for character in text]
            if (not any(category in {"L", "N"} for category in categories) or
                any(character != " " and category not in {"L", "M", "N"}
                    for character, category in zip(text, categories, strict=True))):
                raise ValueError("phonemization inputs must contain only Unicode letters, marks, numbers and spaces")
        return texts


class PhonemizeBodyLimit:
    """Bound the encoded body before JSON parsing, including chunked requests."""
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http" or scope.get("path") != "/v1/phonemize":
            return await self.app(scope, receive, send)
        chunks, size = [], 0
        try:
            async with asyncio.timeout(5):
                while True:
                    message = await receive()
                    if message["type"] == "http.disconnect":
                        return
                    body = message.get("body", b"")
                    size += len(body)
                    if size > MAX_REQUEST_BYTES:
                        await self.error(scope, send, 413, "request_too_large")
                        return
                    chunks.append(body)
                    if not message.get("more_body", False):
                        break
        except asyncio.TimeoutError:
            await self.error(scope, send, 408, "request_timeout")
            return
        delivered = False
        async def buffered_receive():
            nonlocal delivered
            if not delivered:
                delivered = True
                return {"type": "http.request", "body": b"".join(chunks), "more_body": False}
            return await receive()
        return await self.app(scope, buffered_receive, send)

    @staticmethod
    async def error(scope, send, status, code):
        body = json.dumps({"error": {"code": code, "message": "Phonemization request exceeds its input limits"},
                           "request_id": scope.get("state", {}).get("request_id")}).encode()
        await send({"type": "http.response.start", "status": status,
                    "headers": [(b"content-type", b"application/json"), (b"content-length", str(len(body)).encode())]})
        await send({"type": "http.response.body", "body": body})


class NativePhonemizer:
    def __init__(self, executable: str | None, *, max_active=2, timeout=8.0, spawn=asyncio.create_subprocess_exec):
        if not 1 <= max_active <= 16 or not 0 < timeout <= 30:
            raise ValueError("invalid phonemizer operating limits")
        self.executable, self.max_active, self.timeout, self.spawn = executable, max_active, timeout, spawn
        self.active = 0
        self.version = None
        self.reason = "not_probed" if executable else "not_installed"

    @classmethod
    def configured(cls):
        configured = os.getenv("CONTENT_ESPEAK_BIN", "espeak-ng")
        executable = shutil.which(configured)
        try:
            return cls(executable, max_active=int(os.getenv("CONTENT_PHONEMIZE_MAX_ACTIVE", "2")),
                       timeout=float(os.getenv("CONTENT_PHONEMIZE_TIMEOUT", "8")))
        except ValueError:
            disabled = cls(None)
            disabled.reason = "configuration_invalid"
            return disabled

    def capability(self):
        return {"ready": self.version is not None and self.executable is not None,
                "engine": self.identity() if self.version else None, "reason": self.reason,
                "max_texts": MAX_TEXTS, "max_text_characters": MAX_TEXT_CHARACTERS,
                "max_active": self.max_active, "timeout_seconds": self.timeout}

    def identity(self):
        return {"name": "espeak-ng", "version": self.version, "voice": "en-us"}

    async def initialize(self):
        if not self.executable:
            return
        try:
            output = await asyncio.wait_for(self._run(["--version"], b""), timeout=self.timeout)
            match = re.search(r"eSpeak NG text-to-speech:\s*([0-9][A-Za-z0-9.+_-]*)", output)
            if not match:
                raise ContentError("phonemizer_unavailable", "Native phonemizer identity is unavailable")
            voice = await asyncio.wait_for(self._run(["-q", "--ipa", "-v", "en-us", "--stdin"], b"voice check"), timeout=self.timeout)
            if not voice.strip():
                raise ContentError("phonemizer_unavailable", "Native phonemizer voice is unavailable")
            # Version metadata is process configuration; no personal text is retained.
            self.version, self.reason = match[1], None
        except (ContentError, OSError, asyncio.TimeoutError):
            self.version, self.reason = None, "engine_unavailable"

    async def convert(self, body: PhonemizeRequest):
        if not self.version or not self.executable:
            raise ContentError("phonemizer_unavailable", "Optional native phonemization is unavailable")
        # No awaiting between admission and increment: excess requests never build an unbounded queue.
        if self.active >= self.max_active:
            raise ContentError("phonemizer_busy", "Optional phonemization is busy; ordinary transcription remains available")
        self.active += 1
        try:
            async with asyncio.timeout(self.timeout):
                phonemes = []
                for text in body.texts:
                    # Separate processes guarantee alignment even if engine clause/newline behavior changes.
                    output = await self._run(["-q", "--ipa", "-v", body.language, "--stdin"], text.encode("utf-8"))
                    normalized = " ".join(output.split())
                    if not normalized:
                        raise ContentError("phonemizer_failed", "Native phonemizer returned an empty pronunciation")
                    phonemes.append(normalized)
                return {"phonemes": phonemes, "engine": self.identity()}
        except asyncio.TimeoutError:
            raise ContentError("phonemizer_timeout", "Optional phonemization exceeded its execution deadline", 504) from None
        except OSError:
            self.version, self.reason = None, "engine_unavailable"
            raise ContentError("phonemizer_unavailable", "Optional native phonemization is unavailable") from None
        finally:
            self.active -= 1

    async def _run(self, arguments, data):
        spawn = asyncio.create_task(self.spawn(self.executable, *arguments, stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE, start_new_session=True))
        try:
            process = await asyncio.shield(spawn)
        except asyncio.CancelledError:
            # A cancelled spawn still has an owner until any created process is reaped.
            while not spawn.done():
                try:
                    await asyncio.shield(spawn)
                except asyncio.CancelledError:
                    pass
            try:
                process = spawn.result()
            except Exception:
                raise asyncio.CancelledError from None
            await self._cleanup(process, [])
            raise
        tasks = []
        try:
            async def bounded(stream):
                chunks, length = [], 0
                while chunk := await stream.read(4096):
                    length += len(chunk)
                    if length > MAX_OUTPUT_BYTES:
                        raise ContentError("phonemizer_failed", "Native phonemizer exceeded its output limit")
                    chunks.append(chunk)
                return b"".join(chunks)
            tasks = [asyncio.create_task(bounded(process.stdout)), asyncio.create_task(bounded(process.stderr))]
            process.stdin.write(data)
            await process.stdin.drain()
            process.stdin.close()
            stdout, _stderr = await asyncio.gather(*tasks)
            code = await process.wait()
            if code != 0:
                raise ContentError("phonemizer_failed", "Native phonemizer failed")
            try:
                return stdout.decode("utf-8", errors="strict")
            except UnicodeError:
                raise ContentError("phonemizer_failed", "Native phonemizer returned invalid encoding") from None
        finally:
            await self._cleanup(process, tasks)

    @staticmethod
    async def _cleanup(process, tasks):
        async def reap():
            if process.returncode is None:
                try:
                    os.killpg(process.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
            for task in tasks:
                if not task.done():
                    task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
            await process.wait()
        cleanup = asyncio.create_task(reap())
        cancelled = False
        while not cleanup.done():
            try:
                await asyncio.shield(cleanup)
            except asyncio.CancelledError:
                cancelled = True
        cleanup.result()
        if cancelled:
            raise asyncio.CancelledError
