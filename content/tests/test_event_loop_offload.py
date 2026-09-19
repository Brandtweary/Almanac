"""The service has one event loop, so its CPU/disk work must not sit on it."""
import asyncio
import threading
import time
from contextlib import contextmanager
from pathlib import Path
from types import SimpleNamespace

from oracle_content.service import Service


class _Catalog:
    """Just enough catalog for the non-native lexical path to reach a ZIM hit."""

    def execute(self, sql, params=()):
        if "original_path FROM documents" in sql:
            return [("archive.zim",)]
        return []


class _Store:
    root = Path("/nonexistent")

    def native(self, generation):
        return None

    def lexical(self, generation, query, depth, document_id):
        return []

    @contextmanager
    def connect(self, generation):
        yield _Catalog()


class _Zim:
    async def search(self, path, query, limit, title_query=None):
        return ["Article"]


def test_native_localization_does_not_occupy_the_event_loop():
    """A coroutine yields only at an await, so localization running inline stalls
    every other in-flight request for its whole duration."""
    service = Service.__new__(Service)
    service.store = _Store()
    service.zim = _Zim()
    service.profile = SimpleNamespace(lexical_depth=5, rrf_k=60)

    loop_thread = threading.get_ident()
    localization_thread = []

    def slow_localize(generation, path, hits, query, document_id):
        localization_thread.append(threading.get_ident())
        time.sleep(0.2)
        return []

    service._localize_native_hits = slow_localize

    async def exercise():
        ticks = 0

        async def other_request():
            nonlocal ticks
            while True:
                await asyncio.sleep(0.005)
                ticks += 1

        concurrent = asyncio.ensure_future(other_request())
        try:
            await service.lexical("generation", "query", None)
        finally:
            concurrent.cancel()
        return ticks

    ticks = asyncio.run(exercise())
    assert localization_thread, "the localization helper never ran"
    assert localization_thread[0] != loop_thread, (
        "localization ran on the event loop thread, which blocks every "
        "concurrent request for its duration")
    assert ticks > 5, (
        f"only {ticks} concurrent ticks completed during a 0.2s localization — "
        "the loop was blocked")


def test_concurrent_lexical_requests_queue_instead_of_interleaving():
    """Localization is interpreter-bound, so overlapping it buys no throughput.

    Run together, two searches each finish at the cost of both and neither is
    answered early; admitted in arrival order, the first is answered at its own
    cost. The gate is what makes the second search wait rather than share.
    """
    service = Service.__new__(Service)
    service.store = _Store()
    service.zim = _Zim()
    service.profile = SimpleNamespace(lexical_depth=5, rrf_k=60)

    live, peak = 0, 0

    def slow_localize(generation, path, hits, query, document_id):
        nonlocal live, peak
        live += 1
        peak = max(peak, live)
        time.sleep(0.2)
        live -= 1
        return []

    service._localize_native_hits = slow_localize

    async def exercise():
        await asyncio.gather(service.lexical("generation", "one", None),
                             service.lexical("generation", "two", None))

    asyncio.run(exercise())
    assert peak == 1, f"{peak} localizations ran at once; concurrent searches share the interpreter"
