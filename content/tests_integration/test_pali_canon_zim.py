"""Real libzim build and verification of a Pali-canon archive; no network.

A structurally valid but empty archive is the characteristic failure of this build, and it
looks like success from outside, so every check here is also exercised against an archive
broken on purpose.
"""
import hashlib
import json
from pathlib import Path
import sys

import pytest

TOOLS = Path(__file__).resolve().parent.parent / "tools"
sys.path.insert(0, str(TOOLS))

from build_pali_canon_zim import build  # noqa: E402
from pali_canon import SourceError, inline, render_segments, survey  # noqa: E402
from verify_pali_canon_zim import verify  # noqa: E402

COLLECTIONS = {"dn": 34, "mn": 152}
AUTHOR = "sujato"


def write_source(root: Path) -> Path:
    """Lay out a miniature checkout with the directory shape the real source has."""
    root.mkdir(parents=True, exist_ok=True)
    (root / "_author.json").write_text(json.dumps(
        {AUTHOR: {"type": "translator", "name": "Bhikkhu Sujato"}}), encoding="utf-8")
    (root / "_publication.json").write_text(json.dumps(
        {"scpub1": {"text_uid": "mn", "license": {"license_abbreviation": "CC0"}}}), encoding="utf-8")
    names = {}
    for collection, count in COLLECTIONS.items():
        translations = root / "translation" / "en" / AUTHOR / "sutta" / collection
        markup = root / "html" / "pli" / "ms" / "sutta" / collection
        translations.mkdir(parents=True, exist_ok=True)
        markup.mkdir(parents=True, exist_ok=True)
        for number in range(1, count + 1):
            uid = f"{collection}{number}"
            segments = {
                f"{uid}:0.1": f"Collection {number} ",
                f"{uid}:0.2": f"Discourse Titled {uid} ",
                f"{uid}:1.1": "So I have heard. ",
                f"{uid}:1.2": f"A passage peculiar to {uid}, with *emphasis* and _pali_ and a 5 < 7 comparison. ",
            }
            templates = {
                f"{uid}:0.1": "<article id='%s'><header><ul><li class='division'>{}</li></ul>" % uid,
                f"{uid}:0.2": "<h1 class='sutta-title'>{}</h1></header>",
                f"{uid}:1.1": "<p><span class='evam'>{}</span>",
                f"{uid}:1.2": "{}</p></article>",
            }
            (translations / f"{uid}_translation-en-{AUTHOR}.json").write_text(
                json.dumps(segments, ensure_ascii=False), encoding="utf-8")
            (markup / f"{uid}_html.json").write_text(
                json.dumps(templates, ensure_ascii=False), encoding="utf-8")
            names[f"{collection}-name:{number}.{uid}"] = f"Discourse Titled {uid}"
    name_dir = root / "translation" / "en" / AUTHOR / "name" / "sutta"
    name_dir.mkdir(parents=True, exist_ok=True)
    (name_dir / f"all-name_translation-en-{AUTHOR}.json").write_text(
        json.dumps(names, ensure_ascii=False), encoding="utf-8")
    return root


@pytest.fixture
def archive(tmp_path):
    source = write_source(tmp_path / "source")
    output = tmp_path / "pali.zim"
    receipt = build(source, output, language="en", root_language="pli",
                    date="2026-01-01", name="pali-canon_en_test")
    return source, output, receipt


def test_build_covers_every_declared_text_and_verifies(archive):
    source, output, receipt = archive
    assert receipt["coverage"]["declared_texts"] == sum(COLLECTIONS.values())
    assert receipt["coverage"]["written_texts"] == receipt["coverage"]["declared_texts"]
    assert receipt["failures"] == []
    assert receipt["archive"]["sha256"] == hashlib.sha256(output.read_bytes()).hexdigest()
    assert verify(output, receipt, source, sample=20, seed=1) == []


def test_verification_fails_when_the_archive_holds_no_articles(archive, tmp_path):
    """The characteristic failure: a well-formed archive with nothing in it."""
    from libzim.writer import Creator
    source, output, receipt = archive
    empty = tmp_path / "empty.zim"
    with Creator(str(empty)).config_indexing(True, "eng") as creator:
        creator.add_metadata("Title", "Empty")
    receipt["archive"]["bytes"] = empty.stat().st_size
    receipt["archive"]["sha256"] = hashlib.sha256(empty.read_bytes()).hexdigest()
    problems = verify(empty, receipt, source, sample=20, seed=1)
    assert any("articles" in problem for problem in problems)
    assert sum("absent from archive" in problem for problem in problems) == sum(COLLECTIONS.values())


def test_verification_fails_when_an_article_is_truncated(archive, tmp_path):
    """A build that drops the back half of every discourse still opens and still searches."""
    from libzim.writer import Creator, Hint, Item, StringProvider

    class Truncated(Item):
        def __init__(self, path, title, content):
            super().__init__()
            self._path, self._title, self._content = path, title, content

        def get_path(self):
            return self._path

        def get_title(self):
            return self._title

        def get_mimetype(self):
            return "text/html"

        def get_contentprovider(self):
            return StringProvider(self._content)

        def get_hints(self):
            return {Hint.FRONT_ARTICLE: True}

    source, output, receipt = archive
    from libzim.reader import Archive
    original = Archive(str(output))
    damaged = tmp_path / "truncated.zim"
    declared = survey(source, "en", "pli")
    with Creator(str(damaged)).config_indexing(True, "eng") as creator:
        for text in declared.texts:
            entry = original.get_entry_by_path(text.entry_path)
            content = bytes(entry.get_item().content).decode("utf-8")
            creator.add_item(Truncated(text.entry_path, entry.title,
                                       content[:content.index("<p><span class='evam'>")] + "</body></html>"))
    receipt["archive"]["bytes"] = damaged.stat().st_size
    receipt["archive"]["sha256"] = hashlib.sha256(damaged.read_bytes()).hexdigest()
    problems = verify(damaged, receipt, source, sample=20, seed=1)
    assert sum("segments" in problem for problem in problems) == sum(COLLECTIONS.values())


def test_verification_fails_without_a_native_full_text_index(archive, tmp_path):
    """The corpus reader's native path needs the index; an unindexed build is unusable."""
    from libzim.reader import Archive
    from libzim.writer import Creator, Hint, Item, StringProvider
    source, output, receipt = archive
    original = Archive(str(output))
    unindexed = tmp_path / "unindexed.zim"

    class Plain(Item):
        def __init__(self, path, title, content):
            super().__init__()
            self._path, self._title, self._content = path, title, content

        def get_path(self):
            return self._path

        def get_title(self):
            return self._title

        def get_mimetype(self):
            return "text/html"

        def get_contentprovider(self):
            return StringProvider(self._content)

        def get_hints(self):
            return {Hint.FRONT_ARTICLE: True}

    with Creator(str(unindexed)).config_indexing(False, "eng") as creator:
        for text in survey(source, "en", "pli").texts:
            entry = original.get_entry_by_path(text.entry_path)
            creator.add_item(Plain(text.entry_path, entry.title,
                                   bytes(entry.get_item().content).decode("utf-8")))
    receipt["archive"]["bytes"] = unindexed.stat().st_size
    receipt["archive"]["sha256"] = hashlib.sha256(unindexed.read_bytes()).hexdigest()
    problems = verify(unindexed, receipt, source, sample=5, seed=1)
    assert any("full-text index" in problem for problem in problems)


def test_verification_fails_when_the_archive_bytes_do_not_match_the_receipt(archive):
    source, output, receipt = archive
    receipt["archive"]["sha256"] = "0" * 64
    assert any("sha256" in problem for problem in verify(output, receipt, source, sample=5, seed=1))


def test_canonical_discourse_counts_are_checked_against_the_archive(archive, tmp_path):
    """An archive one discourse short is caught by the canon's own numbers."""
    from libzim.reader import Archive
    from libzim.writer import Creator, Hint, Item, StringProvider

    class Copy(Item):
        def __init__(self, path, title, content):
            super().__init__()
            self._path, self._title, self._content = path, title, content

        def get_path(self):
            return self._path

        def get_title(self):
            return self._title

        def get_mimetype(self):
            return "text/html"

        def get_contentprovider(self):
            return StringProvider(self._content)

        def get_hints(self):
            return {Hint.FRONT_ARTICLE: True}

    source, output, receipt = archive
    original = Archive(str(output))
    short = tmp_path / "short.zim"
    omitted = f"suttacentral.net/mn152/en/{AUTHOR}"
    with Creator(str(short)).config_indexing(True, "eng") as creator:
        for text in survey(source, "en", "pli").texts:
            if text.entry_path == omitted:
                continue
            entry = original.get_entry_by_path(text.entry_path)
            creator.add_item(Copy(text.entry_path, entry.title,
                                  bytes(entry.get_item().content).decode("utf-8")))
    receipt["archive"]["bytes"] = short.stat().st_size
    receipt["archive"]["sha256"] = hashlib.sha256(short.read_bytes()).hexdigest()
    problems = verify(short, receipt, source, sample=5, seed=1)
    assert any("canon has 152" in problem for problem in problems)
    assert any(omitted in problem for problem in problems)


def test_the_primary_translator_owns_the_bare_identifier_path(tmp_path):
    """A text two translators carry redirects to the ranked one, not to whoever sorts first."""
    from libzim.reader import Archive
    from build_pali_canon_zim import PRIMARY_TRANSLATORS
    source = write_source(tmp_path / "source")
    rival = "asuddhaso"  # sorts before `sujato`, as the real contesting translators do
    for collection in ("mn",):
        base = source / "translation" / "en"
        target = base / rival / "sutta" / collection
        target.mkdir(parents=True, exist_ok=True)
        original = (base / AUTHOR / "sutta" / collection / f"{collection}2_translation-en-{AUTHOR}.json")
        segments = json.loads(original.read_text(encoding="utf-8"))
        (target / f"{collection}2_translation-en-{rival}.json").write_text(
            json.dumps(segments, ensure_ascii=False), encoding="utf-8")
    assert rival < AUTHOR and PRIMARY_TRANSLATORS[0] == AUTHOR
    output = tmp_path / "contested.zim"
    receipt = build(source, output, language="en", root_language="pli",
                    date="2026-01-01", name="contested")
    assert receipt["coverage"]["contested_uids"] == ["mn2"]
    assert receipt["coverage"]["primary_unranked_uids"] == []
    entry = Archive(str(output)).get_entry_by_path("suttacentral.net/mn2")
    assert entry.is_redirect
    assert entry.get_item().path == f"suttacentral.net/mn2/en/{AUTHOR}"


def test_listing_pages_link_relative_to_their_own_path(archive):
    """A root-absolute link resolves against the host, not the book."""
    from libzim.reader import Archive
    source, output, receipt = archive
    reader = Archive(str(output))
    index = bytes(reader.get_entry_by_path("suttacentral.net/index").get_item().content).decode()
    listing = bytes(reader.get_entry_by_path("suttacentral.net/collection/mn").get_item().content).decode()
    assert "href='/" not in index and "href='/" not in listing
    assert "href='collection/mn'" in index
    assert f"href='../mn1/en/{AUTHOR}'" in listing


def test_inline_markup_is_converted_and_stray_markup_escaped():
    rendered = inline("a *stressed* word, a _root_ word, #12, 5 < 7 & <em>kept</em> <script>no</script>")
    assert "<em>stressed</em>" in rendered
    assert "<i lang='pi' translate='no'>root</i>" in rendered
    assert "<span class='counter'>12</span>" in rendered
    assert "5 &lt; 7 &amp;" in rendered
    assert "<em>kept</em>" in rendered
    assert "&lt;script&gt;" in rendered


def test_a_restricted_publication_excludes_the_directory_it_names(tmp_path):
    source = write_source(tmp_path / "source")
    records = json.loads((source / "_publication.json").read_text(encoding="utf-8"))
    records["scpub2"] = {
        "text_uid": "dn",
        "license": {"license_abbreviation": "CC BY-SA 3.0"},
        "source_url": f"https://github.com/suttacentral/bilara-data/tree/published/translation/en/{AUTHOR}/sutta/dn",
    }
    (source / "_publication.json").write_text(json.dumps(records), encoding="utf-8")
    result = survey(source, "en", "pli")
    assert len(result.excluded["not_public_domain"]) == COLLECTIONS["dn"]
    assert not any(text.collection == "dn" for text in result.texts)


def test_a_restricted_publication_naming_no_directory_is_refused(tmp_path):
    """The licence gate is the load-bearing rights claim; it may not fail open."""
    source = write_source(tmp_path / "source")
    records = json.loads((source / "_publication.json").read_text(encoding="utf-8"))
    records["scpub3"] = {"text_uid": "mystery",
                         "license": {"license_abbreviation": "CC BY-NC 4.0"}, "source_url": ""}
    (source / "_publication.json").write_text(json.dumps(records), encoding="utf-8")
    with pytest.raises(SourceError, match="name no translation directory"):
        survey(source, "en", "pli")


def test_a_publication_governing_only_root_texts_restricts_nothing(tmp_path):
    """Root texts are not carried, so a record over them excludes no translation."""
    source = write_source(tmp_path / "source")
    records = json.loads((source / "_publication.json").read_text(encoding="utf-8"))
    records["scpub4"] = {"text_uid": "ms", "license": {},
                         "source_url": "https://github.com/suttacentral/bilara-data/tree/published/root/pli/ms"}
    (source / "_publication.json").write_text(json.dumps(records), encoding="utf-8")
    assert len(survey(source, "en", "pli").texts) == sum(COLLECTIONS.values())


def test_a_segment_without_a_template_is_refused_rather_than_dropped():
    with pytest.raises(SourceError):
        render_segments({"mn1:1.1": "text"}, {})


def test_a_template_without_exactly_one_placeholder_is_refused():
    with pytest.raises(SourceError):
        render_segments({"mn1:1.1": "text"}, {"mn1:1.1": "<p>no placeholder</p>"})
