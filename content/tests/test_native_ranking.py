from types import SimpleNamespace

import pytest

from oracle_content.native import NativeReader
from oracle_content.adapters import ZimLexical


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


@pytest.mark.parametrize("query", ["Water", "water"])
def test_exact_title_is_discoverable_when_fulltext_buries_article(query):
    import asyncio
    reader = NativeReader.__new__(NativeReader)
    reader.path = "archive.zim"
    reader.verify_original = lambda: None
    def by_title(title):
        if title != "Water":
            raise KeyError(title)
        return SimpleNamespace(path="Water")
    reader.archive = SimpleNamespace(get_entry_by_title=by_title)
    reader._localize = lambda paths, *args: paths
    class Search:
        async def search(self, path, safe, limit, *, title_query):
            assert title_query == query
            return ZimLexical._with_exact_title(reader.archive, title_query,
                ["Water_companies", "Water_politics", "Water_tower"], limit)
    assert asyncio.run(reader.lexical(Search(), query, 3)) == [
        "Water", "Water_companies", "Water_politics",
    ]


def test_exact_title_merge_preserves_depth_and_deduplicates():
    archive = SimpleNamespace(get_entry_by_title=lambda title: SimpleNamespace(path="Water"))
    assert ZimLexical._with_exact_title(archive, "Water", ["Other", "Water", "Third"], 3) == ["Water", "Other", "Third"]


@pytest.mark.parametrize('base,path,expected', [
    ('https://www.example.org', 'www.example.org/manual/Water.html', 'https://www.example.org/manual/Water.html'),
    ('https://en.wikipedia.org/wiki', 'Water', 'https://en.wikipedia.org/wiki/Water'),
])
def test_native_source_url_handles_host_qualified_archive_paths(base, path, expected):
    reader = NativeReader.__new__(NativeReader)
    reader.template = SimpleNamespace(sha256='a'*64, source_url=base, license='source notices', edition='', original_path='archive', model_copy=lambda update: update)
    reader.archive_edition = ''
    reader.rights_exclusions = {}
    reader.policy = 'canonical-html'
    reader.entry = lambda index: SimpleNamespace(path=path, title='Water')
    assert reader._document(reader.document_id(1))['source_url'] == expected
