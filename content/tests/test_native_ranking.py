from types import SimpleNamespace

import pytest

from oracle_content.native import NativeReader


@pytest.mark.parametrize("counts", [[40] * 40, [1] * 40, [0, 2, 19, 1, 0, 40] * 7])
@pytest.mark.parametrize("constant", [1.0, 60.0, 200.0])
def test_lazy_native_localization_matches_exhaustive_ranking(counts, constant):
    reader = NativeReader.__new__(NativeReader)
    reader.profile = SimpleNamespace(rrf_k=constant)
    reader.template = SimpleNamespace(sha256="a" * 64)
    reader.archive = SimpleNamespace(get_entry_by_path=lambda path: SimpleNamespace(is_redirect=False, _index=int(path)))
    reader.document = lambda document_id: SimpleNamespace(document_id=document_id)
    records = {}
    exhaustive = []
    for index, count in enumerate(counts):
        rows = [SimpleNamespace(passage_id=f"p:{'b' * 64}:{index:032x}{ordinal:032x}", lexical_text="pressure regulator")
                for ordinal in range(count)]
        records[reader.document_id(index)] = rows
        for ordinal, row in enumerate(rows, 1):
            exhaustive.append((row.passage_id, 1 / ((constant + index + 1) * (constant + ordinal))))
    visited = []
    def passages(document_id):
        visited.append(document_id)
        return records[document_id]
    reader.passages = passages
    actual = reader._localize([str(index) for index in range(len(counts))], "pressure", 40, None)
    expected = sorted(exhaustive, key=lambda row: (-row[1], row[0]))[:40]
    assert list(actual) == expected
    assert set(actual.passages) == {pid for pid, _ in expected}
    if counts == [40] * 40:
        assert len(visited) < 15
    if counts == [1] * 40:
        assert len(visited) == 40
