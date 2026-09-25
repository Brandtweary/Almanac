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
