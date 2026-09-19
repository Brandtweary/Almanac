"""An input that only overflows the cross-encoder's pair window is not an outage."""
import asyncio

import pytest
from oracle_content.models import ContentError, SearchRequest

from .test_content import Tokens, failure_rows, setup

RERANKER = dict(ranking="reranker", reranker_id="fixture", reranker_revision="test",
                reranker_tokenizer="unused", reranker_tokenizer_sha256="0" * 64,
                reranker_depth=10, reranker_batch=4)


class Ranker:
    """Records what it was asked to score; refuses a pair past the window."""

    def __init__(self, profile):
        self.profile, self.calls = profile, []

    async def rank(self, query, passages):
        self.calls.append([p.passage_id for p in passages])
        if any(Tokens().pair_count(query, p.embedding_text) > self.profile.reranker_max_tokens
               for p in passages):
            raise ValueError("reranker pair exceeds qualified window")
        return {p.passage_id: 1.0 for p in passages}


def _service(tmp_path, **changes):
    service, _doc, _generation = setup(tmp_path, **{**RERANKER, **changes})
    service.reranker = Ranker(service.profile)
    return service


def test_query_past_the_pair_window_is_not_a_reranker_outage(tmp_path):
    """A visitor whose question is merely long would otherwise be recorded as a
    failed reranker, and the fault store would fill with ordinary traffic."""
    service = _service(tmp_path, reranker_max_tokens=2, query_max_chars=4000)
    result = asyncio.run(service.search(SearchRequest(query="paraphrase stopcock")))

    assert failure_rows(service) == [], "an over-long pair is input, not a fault"
    assert "reranker_unavailable" not in result["degradation"]
    assert "reranker_window_exceeded" in result["degradation"]
    assert result["hits"], "candidates that cannot be scored keep their fusion rank"
    assert service.reranker.calls == [], "no batch is sent when every pair overflows"


def test_a_real_reranker_fault_is_still_recorded(tmp_path):
    """The distinction is the point: an outage must keep its diagnostic row."""
    service = _service(tmp_path, reranker_max_tokens=10000)

    async def broken(query, passages):
        raise RuntimeError("reranker connection refused")

    service.reranker.rank = broken
    result = asyncio.run(service.search(SearchRequest(query="ZX-42")))

    assert "reranker_unavailable" in result["degradation"]
    assert [row["stage"] for row in failure_rows(service)] == ["reranker"]


def test_pairs_within_the_window_are_still_reranked(tmp_path):
    service = _service(tmp_path, reranker_max_tokens=10000)
    result = asyncio.run(service.search(SearchRequest(query="ZX-42")))

    assert service.reranker.calls and service.reranker.calls[0]
    assert result["degradation"] == []
    assert failure_rows(service) == []


def test_an_unscorable_pair_fails_a_required_qualified_request(tmp_path):
    """Qualified means the qualified pipeline ran over the whole candidate set."""
    service = _service(tmp_path, reranker_max_tokens=2, query_max_chars=4000)
    with pytest.raises(ContentError, match="qualified"):
        asyncio.run(service.search(SearchRequest(query="paraphrase stopcock", require_qualified=True)))
    assert failure_rows(service) == []
