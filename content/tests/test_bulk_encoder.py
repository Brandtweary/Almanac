import asyncio
import base64
import json
import struct
import sys

import pytest

from tools.bulk_encoder import ProcessEncoder
from tests.test_content import profile, Tokens


def command(p, *, wrong=False, malformed=False):
    identity = {"model_id": p.encoder_id, "revision": p.encoder_revision,
                "tokenizer_sha256": p.encoder_tokenizer_sha256, "dimensions": 3 if wrong else p.encoder_dimensions}
    script = "import sys,json\nprint(" + repr(json.dumps(identity)) + ",flush=True)\n"
    script += "for line in sys.stdin:\n rows=json.loads(line)['texts']\n print(json.dumps({'embeddings':" + ("[[1]]" if malformed else "[[1,0] for _ in rows]") + "}),flush=True)\n"
    return [sys.executable, "-u", "-c", script]


def test_worker_identity_batch_alignment_and_cleanup():
    p = profile()
    async def run():
        encoder = ProcessEncoder(command(p), p, Tokens())
        await encoder.start()
        process = encoder.process
        assert await encoder.encode(["one", "two"]) == [[1, 0], [1, 0]]
        await encoder.close()
        assert encoder.process is None and process.returncode == 0
        wrong = ProcessEncoder(command(p, wrong=True), p, Tokens())
        with pytest.raises(ValueError, match="identity"):
            await wrong.start()
        assert wrong.process is None
        malformed = ProcessEncoder(command(p, malformed=True), p, Tokens())
        await malformed.start()
        try:
            with pytest.raises(ValueError, match="cardinality"):
                await malformed.encode(["one", "two"])
        finally:
            await malformed.close()
    asyncio.run(run())


@pytest.mark.parametrize("values,error", [([0.1, -0.2, 1.0, 0.0], None), ([1.0], "cardinality"),
                                         ([float("nan"), 1.0, 1.0, 0.0], "invalid embedding")])
def test_binary_transport_preserves_float32_and_checks_shape(values, error):
    p = profile()
    identity = {"model_id": p.encoder_id, "revision": p.encoder_revision,
        "tokenizer_sha256": p.encoder_tokenizer_sha256, "dimensions": p.encoder_dimensions,
        "input_contract": {"max_tokens": p.encoder_max_tokens, "overflow": "reject"},
        "vector_transport": "float32-le-base64-v1"}
    raw = struct.pack("<" + "f" * len(values), *values)
    reply = json.dumps({"embeddings_base64": base64.b64encode(raw).decode()})
    script = "import sys\nprint(" + repr(json.dumps(identity)) + ",flush=True)\nfor line in sys.stdin:\n print(" + repr(reply) + ",flush=True)\n"
    class WorkerOwnedTokens:
        def count(self, text):
            raise AssertionError("Negotiated worker owns exact overflow rejection")
    async def run():
        encoder = ProcessEncoder([sys.executable, "-u", "-c", script], p, WorkerOwnedTokens())
        await encoder.start()
        try:
            if error:
                with pytest.raises(ValueError, match=error):
                    await encoder.encode(["one", "two"])
            else:
                result = await encoder.encode(["one", "two"])
                assert [value for row in result for value in row] == list(struct.unpack("<4f", raw))
        finally:
            await encoder.close()
    asyncio.run(run())


def test_unnegotiated_worker_keeps_parent_overflow_guard():
    p = profile()
    class OversizedTokens:
        def count(self, text):
            return p.encoder_max_tokens + 1
    async def run():
        encoder = ProcessEncoder(command(p), p, OversizedTokens())
        await encoder.start()
        try:
            with pytest.raises(ValueError, match="exceeds encoder window"):
                await encoder.encode(["too long"])
        finally:
            await encoder.close()
    asyncio.run(run())
