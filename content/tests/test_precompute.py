"""Precomputed article spans must reproduce query-time passages exactly."""
import json
import sqlite3
import zlib
from pathlib import Path

import pytest

from oracle_content.extract import segment
from oracle_content.models import Block, Document, Passage, Profile
from oracle_content.precompute import ArticleSpans, SCHEMA, decode, encode, rebuild


class Tokens:
    """A whitespace tokenizer is enough: segmentation only needs a count."""

    def count(self, text):
        return len(text.split())


def profile(**overrides):
    values = dict(profile_id="test", encoder_id="e", encoder_revision="1", encoder_dimensions=8,
                  encoder_tokenizer="t.json", encoder_tokenizer_sha256="a" * 64, encoder_max_tokens=24,
                  document_prefix="passage: ", chat_tokenizer="c.json", chat_tokenizer_sha256="b" * 64,
                  lexical_depth=10, dense_depth=10, rrf_k=60, lexical_weight=1, dense_weight=1,
                  page_size=5, response_tokens=1000, read_tokens=1000, query_max_chars=500,
                  request_timeout=30, embedding_batch=8)
    return Profile(**{**values, **overrides})


def document():
    return Document(document_id="z_" + "c" * 64 + "_7", work_id="w", pack_id="p", title="Solar Cooker",
                    language="en", source_url="https://example.org", sha256="d" * 64,
                    media_type="application/x-zim", license="CC-BY-SA-4.0",
                    extraction_revision="html-structural-v4", original_path="originals/" + "d" * 64,
                    article_path="A/Solar_Cooker")


def blocks():
    long_prose = " ".join(f"word{n}" for n in range(200))
    return [
        Block(text="Solar cookers concentrate sunlight.", kind="paragraph", section=["Overview"]),
        Block(text=long_prose, kind="paragraph", section=["Overview", "Construction"],
              flags=["figure_requires_visual_inspection"]),
        Block(text=" | ".join(f"cell{n}" for n in range(400)), kind="table", section=["Data"],
              flags=["table_headers_unverified"]),
        Block(text="A closing note.", kind="list_item", section=["Data"], anchor="notes"),
    ]


def prepared(generation="e" * 64):
    from oracle_content.native import span_handle
    doc, structure, settings, tokens = document(), blocks(), profile(), Tokens()
    passages = segment(doc, structure, settings, tokens, generation)
    for row in passages:
        row.passage_id = span_handle(generation, 7, row)
    for ordinal, row in enumerate(passages):
        row.previous = passages[ordinal - 1].passage_id if ordinal else None
        row.next = passages[ordinal + 1].passage_id if ordinal + 1 < len(passages) else None
    return doc, structure, settings, tokens, passages, generation


def lead_row(doc, generation):
    from oracle_content.native import span_handle
    row = Passage(passage_id="", document_id=doc.document_id, source_revision=doc.sha256,
                  extraction_revision=doc.extraction_revision, ordinal=0, block_index=0xFFFFFFFF,
                  start=0, end=10, text="Solar coo", embedding_text="passage: Solar Cooker\nSolar coo",
                  section=[], kind="article_lead",
                  page={"index": None, "label": None, "coordinates": None, "anchor": None},
                  flags=["text_omitted", "title_lead_semantic_representation"])
    row.passage_id = span_handle(generation, 7, row)
    return row


def test_stored_spans_reconstruct_every_passage_identically():
    """Handle identity is the constraint: a reconstructed passage that differs
    anywhere is a citation that no longer resolves to what it cited."""
    doc, structure, settings, tokens, passages, generation = prepared()
    blob = encode(structure, passages, lead_row(doc, generation), None)
    stored_blocks, spans, stored_lead, license = decode(blob)
    replayed = rebuild(doc, generation, 7, stored_blocks, spans, settings, tokens)
    assert license is None
    assert [row.model_dump() for row in replayed] == [row.model_dump() for row in passages]
    assert stored_lead.model_dump() == lead_row(doc, generation).model_dump()


def test_reconstruction_covers_the_segmentation_edge_cases():
    """The fixture is only evidence if it exercises what makes the encoder text
    diverge from the passage text: an oversized prose block that splits, an
    oversized table that indexes a reference instead, and section metadata that
    fills the window on its own."""
    doc, structure, settings, tokens, passages, generation = prepared()
    flags = {flag for row in passages for flag in row.flags}
    assert "continued_source_block" in flags
    assert "table_exceeds_encoder_window" in flags
    assert any(row.embedding_text.endswith("[Table requires original source inspection]") for row in passages)

    wide = document().model_copy(update={"title": " ".join(f"title{n}" for n in range(60))})
    abbreviated = segment(wide, structure, settings, tokens, generation)
    assert any("embedding_metadata_abbreviated" in row.flags for row in abbreviated)
    from oracle_content.native import span_handle
    for row in abbreviated:
        row.passage_id = span_handle(generation, 7, row)
    for ordinal, row in enumerate(abbreviated):
        row.previous = abbreviated[ordinal - 1].passage_id if ordinal else None
        row.next = abbreviated[ordinal + 1].passage_id if ordinal + 1 < len(abbreviated) else None
    stored_blocks, spans, _lead, _license = decode(encode(structure, abbreviated, lead_row(wide, generation), None))
    replayed = rebuild(wide, generation, 7, stored_blocks, spans, settings, tokens)
    assert [row.model_dump() for row in replayed] == [row.model_dump() for row in abbreviated]


def test_encoding_refuses_flags_that_do_not_extend_their_block():
    """Only the remainder of a passage's flags is stored, which is sound because
    `segment` builds them onto the block's own. Storing a remainder against a
    different premise would silently drop flags from every reconstruction."""
    doc, structure, settings, tokens, passages, generation = prepared()
    passages[0].flags = ["invented_flag"]
    structure[0].flags = ["a_block_flag"]
    with pytest.raises(ValueError, match="extend"):
        encode(structure, passages, lead_row(doc, generation), None)


def write_artifact(directory: Path, expected: dict, payloads: dict):
    db = sqlite3.connect(directory / "article-spans.sqlite")
    db.executescript("""CREATE TABLE articles(entry_index INTEGER PRIMARY KEY, payload BLOB NOT NULL);
        CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);""")
    with db:
        db.execute("INSERT INTO meta VALUES('binding',?)",
                   (json.dumps(expected, sort_keys=True, separators=(",", ":")),))
        db.execute("INSERT INTO meta VALUES('articles',?)", (str(len(payloads)),))
        db.executemany("INSERT INTO articles VALUES(?,?)", payloads.items())
    db.close()


def test_an_artifact_bound_to_another_generation_is_ignored(tmp_path):
    """A stale artifact must read as absent rather than as evidence: serving its
    spans under a changed extractor would answer with passages the current
    generation never produced."""
    expected = {"schema": SCHEMA, "generation": "a" * 64}
    write_artifact(tmp_path, expected, {7: zlib.compress(b"[[],[],{},null]")})
    assert ArticleSpans.open(tmp_path, expected) is not None
    assert ArticleSpans.open(tmp_path, {**expected, "generation": "b" * 64}) is None


def test_a_missing_article_reads_as_absent_rather_than_failing(tmp_path):
    """Partial coverage is the normal state of an interrupted build, and every
    article it never reached still has to be answerable."""
    doc, structure, settings, tokens, passages, generation = prepared()
    expected = {"schema": SCHEMA, "generation": generation}
    write_artifact(tmp_path, expected, {7: encode(structure, passages, lead_row(doc, generation), None)})
    spans = ArticleSpans.open(tmp_path, expected)
    assert spans.raw(7) is not None
    assert spans.raw(8) is None
    assert spans.articles == 1


def test_a_damaged_row_reads_as_absent_and_is_counted(tmp_path):
    """A row that no longer decodes costs that article its precompute, never its request,
    and the count says the artifact is damaged rather than merely partial."""
    doc, structure, settings, tokens, passages, generation = prepared()
    expected = {"schema": SCHEMA, "generation": generation}
    good = encode(structure, passages, lead_row(doc, generation), None)
    write_artifact(tmp_path, expected, {7: good, 8: good[:len(good) // 2], 9: zlib.compress(b"{not json"),
                                        10: zlib.compress(b"[[]]")})
    spans = ArticleSpans.open(tmp_path, expected)
    assert spans.raw(7) is not None
    assert [spans.raw(index) for index in (8, 9, 10)] == [None, None, None]
    assert spans.undecodable == 3


def whole_book(paragraphs=2000):
    """An article shaped like a scanned book: thousands of blocks behind one stored lead."""
    return [Block(text=f"Paragraph {n} of the book.", kind="paragraph", section=["Chapter"]) for n in range(paragraphs)]


def native_reader(spans, policy="canonical-html"):
    """The parts of a reader that a dense hit and a document identity reach."""
    from types import SimpleNamespace
    from oracle_content.native import NativeReader
    reader = NativeReader.__new__(NativeReader)
    reader.spans = spans
    reader.policy = policy
    reader.generation = "e" * 64
    reader.rights_exclusions = {}
    reader.archive_edition = ""
    reader.template = document().model_copy(update={"sha256": "c" * 64, "edition": "",
                                                     "source_url": "https://example.org/book"})
    reader.admit_entry = lambda index: None
    reader.usable_spans = lambda: reader.spans
    reader.entry = lambda index: SimpleNamespace(path="A/Solar_Cooker", title="Solar Cooker")
    return reader


class Unbuilt:
    """Stands in for `Block` where nothing may materialize one."""

    def __init__(self, **_fields):
        raise AssertionError("a block was materialized to read the stored representative")


def test_a_dense_hit_resolves_without_materializing_the_article(tmp_path, monkeypatch):
    """A search resolves every dense candidate to its article's representative, which
    is stored whole beside the article's blocks. Building the blocks to reach it made
    each whole-book hit cost the parse of the book, tens of seconds per search over a
    library of books; the representative and a selection policy's license must be
    read without them."""
    doc, _structure, settings, tokens, _passages, generation = prepared()
    structure = whole_book()
    passages = segment(doc, structure, settings, tokens, generation)
    lead = lead_row(doc, generation)
    expected = {"schema": SCHEMA, "generation": generation}
    write_artifact(tmp_path, expected, {7: encode(structure, passages, lead, "CC0-1.0")})
    spans = ArticleSpans.open(tmp_path, expected)
    monkeypatch.setattr("oracle_content.precompute.Block", Unbuilt)

    assert native_reader(spans).representative(7).model_dump() == lead.model_dump()
    selected = native_reader(spans, policy="gutenberg-books-v1")
    assert selected._document(selected.document_id(7)).license == "CC0-1.0"
    assert spans.undecodable == 0


@pytest.mark.parametrize("license", [None, "CC-BY-SA-4.0", 'odd ,{"passage_id": "x"} ]'])
def test_the_stored_representative_reads_identically_alone(license):
    """Reading the representative alone must agree with the full decode for every
    stored form, including article and license text that quotes the very bytes it
    is located by."""
    from oracle_content.precompute import decode_lead
    doc, _structure, settings, tokens, _passages, generation = prepared()
    structure = [Block(text='he wrote ,{"passage_id":"forged"} and {"passage_id": 1}', section=["A"]),
                 *whole_book(20)]
    passages = segment(doc, structure, settings, tokens, generation)
    lead = lead_row(doc, generation)
    lead.text = lead.embedding_text = '"quoted" ,{"passage_id":"inner"} \\ end'
    blob = encode(structure, passages, lead, license)
    _blocks, _spans, full_lead, full_license = decode(blob)
    assert decode_lead(blob) == (full_lead, full_license)
    assert decode_lead(blob)[0].model_dump() == lead.model_dump()


def test_a_row_not_shaped_as_encoded_falls_back_to_the_full_decode(tmp_path):
    """The representative is located by the shape `encode` writes. Any other shape is
    judged by the full decode, so a lead read accepts and refuses exactly what a full
    read does, and counts a refusal the same way."""
    from oracle_content.precompute import decode_lead
    doc, structure, _settings, _tokens, passages, generation = prepared()
    lead = lead_row(doc, generation).model_dump()
    # Spaced separators are valid JSON that `encode` never writes; the fallback reads them.
    spaced = zlib.compress(json.dumps([[], [], lead, "MIT"]).encode())
    assert decode_lead(spaced)[1] == "MIT"
    expected = {"schema": SCHEMA, "generation": generation}
    good = encode(structure, passages, lead_row(doc, generation), None)
    trailing = zlib.compress(json.dumps([[], [], lead, None, "extra"], separators=(",", ":")).encode())
    misseparated = zlib.compress(b"[[],[]," + json.dumps(lead, separators=(",", ":")).encode() + b';"MIT"]')
    write_artifact(tmp_path, expected, {7: good, 8: good[:len(good) // 2], 9: zlib.compress(b"{not json"),
                                        10: zlib.compress(b"[[]]"), 11: trailing, 12: misseparated})
    spans = ArticleSpans.open(tmp_path, expected)
    assert spans.lead(7) is not None
    assert spans.lead(11) == (Passage.model_validate(lead), None)
    assert [spans.lead(index) for index in (8, 9, 10, 12)] == [None, None, None, None]
    assert spans.undecodable == 4


def test_a_whole_book_is_not_serialized_whole_to_decide_it_is_uncacheable(monkeypatch):
    """Passages too large for the cache are recognised from their first rows; measuring
    every passage of a book to learn that was seconds of each lexical search."""
    from types import SimpleNamespace
    from oracle_content import native
    from oracle_content.native import NativeReader
    doc, _structure, settings, tokens, _passages, generation = prepared()
    structure = whole_book(400)
    passages = segment(doc, structure, settings, tokens, generation)
    rows = [SimpleNamespace(passage_id=row.passage_id, measured=0) for row in passages]
    def dump(row):
        row.measured += 1
        return "x" * 1024
    for row in rows:
        row.model_dump_json = lambda row=row: dump(row)
    monkeypatch.setattr(native, "PASSAGE_CACHE_ENTRY_BYTES", 16 * 1024)
    reader = NativeReader.__new__(NativeReader)
    reader.cache, reader.cache_bytes = native.OrderedDict(), 0
    reader.generation = generation
    reader.template = SimpleNamespace(sha256="c" * 64)
    reader.verify_original = lambda: None
    reader.admit_entry = lambda index: None
    reader.document = lambda document_id: doc
    reader.usable_spans = lambda: None
    reader.segment_article = lambda document, index: rows
    assert reader._passages("z_" + "c" * 64 + "_7") is rows
    assert not reader.cache
    assert sum(row.measured for row in rows) <= 17


def edge_case_blocks():
    """Every way a passage's lexical text departs from its own text, plus shared sections."""
    return [*blocks(),
            Block(text="Formula follows.", kind="paragraph", section=["Data"],
                  flags=["math_requires_original_inspection", "text_omitted"]),
            Block(text="Another note under the same section.", kind="paragraph", section=["Data"])]


def stored_passages(doc, structure, generation, settings, tokens):
    from oracle_content.precompute import StoredPassages, decode_stored
    passages = segment(doc, structure, settings, tokens, generation)
    blob = encode(structure, passages, lead_row(doc, generation), None)
    built = rebuild(doc, generation, 7, *decode(blob)[:2], settings, tokens)
    return StoredPassages(doc, generation, 7, *decode_stored(blob), settings, tokens), built


@pytest.mark.parametrize("title", ["Solar Cooker", " ".join(f"title{n}" for n in range(60))])
def test_stored_passages_agree_with_the_rebuilt_article(title):
    """Localization ranks stored passages by handle and lexical text and builds only the
    ones it keeps; both must be exactly what rebuilding the whole article yields, or a
    lexical hit cites a passage the article does not contain."""
    doc, _structure, settings, tokens, _passages, generation = prepared()
    doc = doc.model_copy(update={"title": title})
    view, built = stored_passages(doc, edge_case_blocks(), generation, settings, tokens)
    flags = {flag for row in built for flag in row.flags}
    assert {"text_omitted", "table_exceeds_encoder_window", "continued_source_block"} <= flags
    assert ("embedding_metadata_abbreviated" in flags) == (title != "Solar Cooker")
    assert view.rows == [(row.passage_id, row.lexical_text) for row in built]
    rows = view.passages([row.passage_id for row in reversed(built)])
    assert {pid: row.model_dump() for pid, row in rows.items()} == {row.passage_id: row.model_dump() for row in built}


def localizing_reader(tmp_path, structure, precomputed):
    """A canonical-HTML reader over one article, precomputed or segmented at query time."""
    import threading
    from oracle_content.native import NativeReader, OrderedDict
    tmp_path.mkdir()
    doc, _structure, settings, tokens, _passages, generation = prepared()
    passages = segment(doc, structure, settings, tokens, generation)
    expected = {"schema": SCHEMA, "generation": generation}
    write_artifact(tmp_path, expected, {7: encode(structure, passages, lead_row(doc, generation), None)})
    reader = native_reader(ArticleSpans.open(tmp_path, expected) if precomputed else None)
    reader.generation, reader.profile, reader.tokenizer = generation, settings, tokens
    reader.template = reader.template.model_copy(update={"title": doc.title})
    reader.cache, reader.cache_bytes, reader.document_cache = OrderedDict(), 0, OrderedDict()
    reader.cache_lock = threading.RLock()
    reader.verify_original = lambda: None
    reader.segment_article = lambda document, index: NativeReader.segment_article(reader, document, index, structure)
    return reader


def test_localizing_a_precomputed_book_builds_only_the_passages_it_keeps(tmp_path, monkeypatch):
    """Lexical localization ranks every passage of each article it reaches and keeps a
    page of them. Building every passage of a book to rank it cost whole seconds per
    book per search; the ranking and the kept passages must equal the built article's
    while only the kept ones are built."""
    from oracle_content import precompute
    structure = whole_book(2000)
    reference = localizing_reader(tmp_path / "segmented", structure, precomputed=False)
    document_id = reference.document_id(7)
    expected = reference._localize([], "paragraph 1500 book", 10, document_id)

    built = []
    original = precompute.rebuild_passage
    def counted(*args, **kwargs):
        built.append(args[3])
        return original(*args, **kwargs)
    monkeypatch.setattr(precompute, "rebuild_passage", counted)
    reader = localizing_reader(tmp_path / "precomputed", structure, precomputed=True)
    actual = reader._localize([], "paragraph 1500 book", 10, document_id)

    assert list(actual) == list(expected) and len(expected) == 10
    assert ({pid: row.model_dump() for pid, row in actual.passages.items()}
            == {pid: row.model_dump() for pid, row in expected.passages.items()})
    assert len(built) == 10


def test_stored_rows_refuse_what_the_full_decode_refuses(tmp_path):
    """Localization reads stored rows without building blocks, so their validation has to
    refuse what `Block` refuses; a refused row falls back to segmenting the original."""
    doc, structure, _settings, _tokens, passages, generation = prepared()
    lead = lead_row(doc, generation).model_dump()
    def row(blocks, spans):
        return zlib.compress(json.dumps([blocks, spans, lead, None], separators=(",", ":")).encode())
    expected = {"schema": SCHEMA, "generation": generation}
    write_artifact(tmp_path, expected, {
        7: encode(structure, passages, lead_row(doc, generation), None),
        8: row([["t", "paragraph", [], None, None, [float("nan")], None, []]], [[0, 0, 1, []]]),
        9: row([["t", "paragraph", [], "page", None, None, None, []]], [[0, 0, 1, []]]),
        10: row([["t", "paragraph", [], None, None, None, None]], [[0, 0, 1, []]]),
        11: row([["t", "paragraph", [], None, None, None, None, []]], [[0, "start", 1, []]])})
    spans = ArticleSpans.open(tmp_path, expected)
    assert spans.stored(7) is not None
    assert [spans.raw(index) for index in (8, 9, 10)] == [None, None, None]
    assert [spans.stored(index) for index in (8, 9, 10, 11)] == [None, None, None, None]
