"""Owner-invoked JSONL encoder process for bounded offline bulk indexing."""
import asyncio
from array import array
import base64
import json
import os
import signal
import sys
import time

from oracle_content.adapters import vectors_valid


class ProcessEncoder:
    def __init__(self, command, profile, tokenizer):
        if not isinstance(command, list) or not command or any(not isinstance(part, str) or not part for part in command):
            raise ValueError("Bulk encoder command must be a nonempty argv array")
        self.command, self.profile, self.tokenizer = command, profile, tokenizer
        self.process = None
        self.identity = None
        self._lock = asyncio.Lock()
        self.last_timings = {"available": False}

    @staticmethod
    async def _finish(task):
        while not task.done():
            try:
                await asyncio.shield(task)
            except asyncio.CancelledError:
                continue
        return task.result()

    async def start(self):
        async with self._lock:
            if self.process is not None:
                raise ValueError("Bulk encoder already started")
            try:
                await self._start()
            except BaseException:
                await self._finish(asyncio.create_task(self._close(force=True)))
                raise

    async def _start(self):
        spawn = asyncio.create_task(asyncio.create_subprocess_exec(*self.command, stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE, limit=16 * 1024 * 1024, start_new_session=True))
        try:
            self.process = await asyncio.shield(spawn)
        except asyncio.CancelledError:
            self.process = await self._finish(spawn)
            raise
        line = await asyncio.wait_for(self.process.stdout.readline(), timeout=120)
        self.identity = json.loads(line)
        if self.identity.get("model_id") != self.profile.encoder_id or self.identity.get("revision") != self.profile.encoder_revision or self.identity.get("tokenizer_sha256") != self.profile.encoder_tokenizer_sha256 or self.identity.get("dimensions") != self.profile.encoder_dimensions:
            raise ValueError("Bulk encoder identity differs from the query encoder profile")
        if self.identity.get("vector_transport") not in (None, "float32-le-base64-v1"):
            raise ValueError("Unsupported bulk encoder vector transport")

    async def encode(self, texts):
        async with self._lock:
            try:
                return await self._encode(texts)
            except BaseException:
                await self._finish(asyncio.create_task(self._close(force=True)))
                raise

    async def _encode(self, texts):
        started = time.perf_counter()
        if self.process is None:
            raise ValueError("Bulk encoder has not started")
        # A qualified worker can enforce the identical tokenizer window while
        # preparing its own tensor, avoiding a second full tokenization pass.
        worker_checks_window = self.identity.get("input_contract") == {
            "max_tokens": self.profile.encoder_max_tokens, "overflow": "reject"}
        if not worker_checks_window and any(self.tokenizer.count(text) > self.profile.encoder_max_tokens for text in texts):
            raise ValueError("Bulk embedding input exceeds encoder window")
        self.process.stdin.write((json.dumps({"texts": texts}) + "\n").encode())
        await asyncio.wait_for(self.process.stdin.drain(), timeout=self.profile.request_timeout)
        sent = time.perf_counter()
        line = await asyncio.wait_for(self.process.stdout.readline(), timeout=self.profile.request_timeout)
        received = time.perf_counter()
        if not line:
            raise ValueError("Bulk encoder ended before returning its batch")
        response = json.loads(line)
        self.last_timings = {"available": True, "input_seconds": sent - started, "response_seconds": received - sent,
            "decode_seconds": time.perf_counter() - received, "worker": response.get("timings", {"available": False})}
        if response.get("error"):
            raise ValueError("Bulk encoder failed: " + str(response["error"]))
        if self.identity.get("vector_transport") == "float32-le-base64-v1":
            raw = base64.b64decode(response.get("embeddings_base64", ""), validate=True)
            dimensions = self.profile.encoder_dimensions
            if len(raw) != len(texts) * dimensions * 4:
                raise ValueError("Bulk embedding binary cardinality mismatch")
            values = array("f")
            values.frombytes(raw)
            if sys.byteorder != "little":
                values.byteswap()
            vectors = [values[offset:offset + dimensions].tolist() for offset in range(0, len(values), dimensions)]
        else:
            vectors = response.get("embeddings")
        self.last_timings["decode_seconds"] = time.perf_counter() - received
        return vectors_valid(vectors, len(texts), self.profile.encoder_dimensions)

    async def close(self):
        async with self._lock:
            task = asyncio.create_task(self._close())
            try:
                await asyncio.shield(task)
            except asyncio.CancelledError:
                await self._finish(task)
                raise

    async def _close(self, force=False):
        process, self.process = self.process, None
        self.identity = None
        if process is None:
            return
        if process.stdin:
            process.stdin.close()
        if not force:
            try:
                await asyncio.wait_for(process.wait(), timeout=30)
            except asyncio.TimeoutError:
                pass
        # The process owns a session so descendants cannot retain its streams.
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        await process.wait()
