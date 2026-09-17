import hashlib

import pytest

from oracle_content.capacity import sample_indices, projection, measure_documents
from oracle_content.models import Document
from oracle_content.models import Block
from oracle_content.extract import segment
from tests.test_content import profile, Tokens


def test_sampling_is_unique_deterministic_and_includes_whole_small_population():
    assert sample_indices(100, 12, 7) == sample_indices(100, 12, 7)
    assert len(set(sample_indices(100, 12, 7))) == 12
    assert sample_indices(4, 99, 7) == [0, 1, 2, 3]
    with pytest.raises(ValueError):
        sample_indices(0, 1, 7)


def test_projection_census_has_no_sampling_error():
    result = projection([2, 4, 6], 3)
    assert result["estimate"] == 12
    assert result["approximate_95_percent_interval"] == [12, 12]
    assert result["census"]


def test_accounting_preserves_zero_cost_observations_and_never_copies_original(tmp_path):
    original = tmp_path / "source.html"
    original.write_text("<h2>First</h2><p>One original passage.</p><h2>Second</h2><p>Another passage.</p>")
    source = Document(document_id="sample", work_id="sample", pack_id="sample", title="Sample", language="en",
        source_url="https://example.invalid/source", sha256=hashlib.sha256(original.read_bytes()).hexdigest(),
        media_type="text/html", license="fixture", extraction_revision="html-structural-v3", original_path=str(original))
    p = profile()
    result, inputs = measure_documents([source, None], p, Tokens(), 20, tmp_path / "scratch")
    assert result["metrics"]["documents"]["estimate"] == 10
    assert result["metrics"]["passages"]["estimate"] == 40
    assert result["storage"]["dense_float32_vector_bytes_extrapolated"] == 40 * p.encoder_dimensions * 4
    assert result["storage"]["two_extraction_receipts_json_bytes_extrapolated"] == 20 * result["metrics"]["extracted_receipt_bytes"]["sample_total"]
    assert result["storage"]["sample_extracted_lexical_rows"] == 4
    assert inputs and result["estimable"]
    assert list((tmp_path / "scratch").iterdir()) == []
    assert original.is_file()


def test_whitespace_free_spans_are_lossless_and_token_measurement_is_bounded(tmp_path):
    from tests.test_content import document
    source = document(tmp_path)
    original = "漢字仮名" * 1000
    calls = []
    class CharacterTokens:
        def count(self, text):
            calls.append(len(text))
            return len(text)
    p = profile(encoder_max_tokens=64)
    rows = segment(source, [Block(text=original)], p, CharacterTokens(), "a" * 64)
    assert "".join(row.text for row in rows) == original
    assert all(len(row.embedding_text) <= 64 for row in rows)
    assert max(calls) <= 64 * 16 + len(source.title) + 3
    assert len(calls) < len(rows) * 12
    assert rows[0].start == 0 and rows[-1].end == len(original)
    assert all(left.end == right.start for left, right in zip(rows, rows[1:]))
