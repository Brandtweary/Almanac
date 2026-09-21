"""Build a ZIM archive of SuttaCentral's English Pali-canon translations.

The archive presents one HTML article per translated text at the text's own site path,
so an ingested article's citation resolves back to the passage it came from. Articles
carry a native full-text index, which is what the corpus reader's native path requires.

    python tools/build_pali_canon_zim.py --source <bilara-data checkout> \
        --output pali-canon_en_<date>.zim --receipt build-receipt.json

The source is a checkout of SuttaCentral's `bilara-data` at its `published` branch, and the
receipt records that commit alongside the coverage the build achieved.

Two builds of one commit hold the same articles but not the same bytes: libzim stamps each
archive with a fresh UUID, which its writer exposes no way to pin, and that propagates into
the trailing checksum and the full-text index. So rebuilding and comparing digests is not an
available integrity check. What is pinnable is one published copy, whose digest the receipt
carries; `verify_pali_canon_zim.py` re-derives coverage from the source instead.
"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import posixpath
import struct
import subprocess
import sys
import zlib

sys.path.insert(0, str(Path(__file__).resolve().parent))

from pali_canon import (  # noqa: E402
    SourceError, Text, publication_licenses, render_segments, survey, title_table,
)

LICENSE_TEXT = """SuttaCentral's translations are dedicated to the public domain under
Creative Commons Zero (CC0 1.0). Attribution is not legally required; it is preserved here
because the dedication is a gift and its authorship should stay legible."""

LICENSE_URL = "https://creativecommons.org/publicdomain/zero/1.0/"
SITE_URL = "https://suttacentral.net/"
MAIN_PATH = "suttacentral.net/index"

# The collection prefixes carried by the archive, in canonical order, with the
# division each belongs to. A collection the source grows into is still built; it
# simply sorts after these and is labelled by its own directory name.
COLLECTION_TITLES = {
    "dn": "Dīgha Nikāya — Long Discourses",
    "mn": "Majjhima Nikāya — Middle Discourses",
    "sn": "Saṁyutta Nikāya — Linked Discourses",
    "an": "Aṅguttara Nikāya — Numbered Discourses",
    "kn": "Khuddaka Nikāya — Minor Collection",
    "vinaya": "Vinaya Piṭaka — Monastic Law",
}
COLLECTION_ORDER = list(COLLECTION_TITLES)

# Every text keeps its own article under its translator; this decides only which one the
# bare `suttacentral.net/<uid>` path reaches. Ordered after SuttaCentral's own presentation:
# its `suttaplex` listing puts Sujato's translation first for every text two translators
# share. A text contested by translators this does not rank keeps a stable order but is
# decided by neither the source nor this list, so the receipt names it.
PRIMARY_TRANSLATORS = ("sujato",)

DOCUMENT = """<!DOCTYPE html>
<html lang="{language}"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{title}</title></head>
<body>{body}</body></html>"""


def illustration(size: int = 48) -> bytes:
    """Draw the archive's icon: a ring on a dark field, as raw PNG bytes.

    A ZIM needs an illustration to be well formed. Generating one keeps the build free of
    an image dependency and of anyone else's artwork.
    """
    background, ring = (24, 26, 33), (214, 176, 96)
    centre, outer, inner = (size - 1) / 2, size * 0.40, size * 0.30
    rows = bytearray()
    for y in range(size):
        rows.append(0)
        for x in range(size):
            distance = ((x - centre) ** 2 + (y - centre) ** 2) ** 0.5
            rows.extend(ring if inner <= distance <= outer else background)

    def chunk(kind: bytes, payload: bytes) -> bytes:
        body = kind + payload
        return struct.pack(">I", len(payload)) + body + struct.pack(">I", zlib.crc32(body))

    header = struct.pack(">IIBBBBB", size, size, 8, 2, 0, 0, 0)
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", header)
            + chunk(b"IDAT", zlib.compress(bytes(rows), 9)) + chunk(b"IEND", b""))


def article_html(text: Text, title: str, rendered: str, author_name: str) -> str:
    """Wrap a rendered text as a standalone article with its own provenance footer."""
    header = (f"<p class='reference'>{text.uid} · translated by {author_name}"
              f" · <a href='{text.source_url}'>{text.source_url}</a></p>")
    footer = ("<footer class='licence'><p>Translation dedicated to the public domain under "
              f"<a href='{LICENSE_URL}'>CC0 1.0</a> by {author_name}, via "
              f"<a href='{SITE_URL}'>SuttaCentral</a>.</p></footer>")
    return DOCUMENT.format(language=text.language, title=escape_attribute(title),
                           body=header + rendered + footer)


def escape_attribute(value: str) -> str:
    return value.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def collection_key(collection: str) -> tuple[int, str]:
    return (COLLECTION_ORDER.index(collection) if collection in COLLECTION_ORDER
            else len(COLLECTION_ORDER), collection)


def index_html(page: str, title: str, intro: str, links: list[tuple[str, str]]) -> str:
    """Render a listing page, linking relative to the page's own path.

    A reader serves a ZIM under whatever prefix it chooses, so a root-absolute link leaves
    the archive and resolves against the host instead of the book.
    """
    here = posixpath.dirname(page)
    items = "".join(
        f"<li><a href='{escape_attribute(posixpath.relpath(path, here))}'>"
        f"{escape_attribute(label)}</a></li>" for path, label in links)
    return DOCUMENT.format(language="en", title=escape_attribute(title),
                           body=f"<main><h1>{escape_attribute(title)}</h1>{intro}<ul>{items}</ul></main>")


def source_commit(source: Path) -> str:
    try:
        return subprocess.run(["git", "-C", str(source), "rev-parse", "HEAD"],
                              capture_output=True, text=True, check=True).stdout.strip()
    except (OSError, subprocess.CalledProcessError):
        return ""


def build(source: Path, output: Path, *, language: str, root_language: str,
          date: str, name: str) -> dict:
    """Render every in-scope text into `output` and return the build receipt."""
    from libzim.writer import Creator, Hint, Item, StringProvider

    class Article(Item):
        def __init__(self, path: str, title: str, content: str, front: bool = True):
            super().__init__()
            self._path, self._title, self._content, self._front = path, title, content, front

        def get_path(self):
            return self._path

        def get_title(self):
            return self._title

        def get_mimetype(self):
            return "text/html"

        def get_contentprovider(self):
            return StringProvider(self._content)

        def get_hints(self):
            return {Hint.FRONT_ARTICLE: self._front}

    declared = survey(source, language, root_language)
    titles = title_table(source, language)
    authors = json.loads((source / "_author.json").read_text(encoding="utf-8"))

    def author_name(uid: str) -> str:
        record = authors.get(uid)
        if isinstance(record, dict):
            for field in ("long_name", "short_name", "name"):
                if record.get(field):
                    return record[field]
        return uid

    written: list[tuple[Text, str]] = []
    failures: list[dict] = []
    segments = 0
    carried: dict[str, list[Text]] = {}

    output.parent.mkdir(parents=True, exist_ok=True)
    creator = Creator(str(output)).config_indexing(True, "eng")
    with creator as archive:
        for metadata, value in {
            "Name": name, "Title": "Pali Canon — SuttaCentral English translations",
            "Creator": "SuttaCentral translators", "Publisher": "Almanac",
            "Date": date, "Language": "eng",
            "Description": "English translations of the Pali canon from SuttaCentral, CC0.",
            "LongDescription": LICENSE_TEXT.replace("\n", " "),
            "Source": SITE_URL, "License": "CC0-1.0", "Scraper": "almanac build_pali_canon_zim",
        }.items():
            archive.add_metadata(metadata, value)
        archive.add_illustration(48, illustration())

        for text in declared.texts:
            try:
                translation = json.loads(text.translation_path.read_text(encoding="utf-8"))
                markup = json.loads(text.markup_path.read_text(encoding="utf-8"))
                rendered = render_segments(translation, markup)
            except (SourceError, ValueError, OSError) as error:
                failures.append({"uid": text.uid, "author": text.author,
                                 "path": str(text.translation_path), "error": str(error)})
                continue
            if not rendered.strip():
                failures.append({"uid": text.uid, "author": text.author,
                                 "path": str(text.translation_path), "error": "rendered empty"})
                continue
            name_of = author_name(text.author)
            title = f"{titles.get(text.uid, text.uid)} ({text.uid})"
            archive.add_item(Article(text.entry_path, title,
                                     article_html(text, title, rendered, name_of)))
            written.append((text, title))
            segments += len(translation)
            carried.setdefault(text.uid, []).append(text)

        by_collection: dict[str, list[tuple[Text, str]]] = {}
        for text, title in written:
            by_collection.setdefault(text.collection, []).append((text, title))

        for collection, entries in by_collection.items():
            path = f"suttacentral.net/collection/{collection}"
            label = COLLECTION_TITLES.get(collection, collection)
            archive.add_item(Article(path, label, index_html(
                path, label, f"<p>{len(entries)} texts.</p>",
                [(text.entry_path, title) for text, title in entries]), front=False))

        archive.add_item(Article(MAIN_PATH, "Pali Canon", index_html(
            MAIN_PATH, "Pali Canon — SuttaCentral English translations",
            f"<p>{len(written)} texts. {LICENSE_TEXT}</p>",
            [(f"suttacentral.net/collection/{collection}",
              COLLECTION_TITLES.get(collection, collection))
             for collection in sorted(by_collection, key=collection_key)]), front=False))

        def rank(text: Text) -> int:
            return (PRIMARY_TRANSLATORS.index(text.author) if text.author in PRIMARY_TRANSLATORS
                    else len(PRIMARY_TRANSLATORS))

        preferred, unranked = {}, []
        for uid, texts in carried.items():
            preferred[uid] = min(texts, key=rank)
            if len(texts) > 1 and not any(text.author in PRIMARY_TRANSLATORS for text in texts):
                unranked.append(uid)
            archive.add_redirection(f"suttacentral.net/{uid}", uid, preferred[uid].entry_path,
                                    {Hint.FRONT_ARTICLE: False})
        archive.set_mainpath(MAIN_PATH)

    digest = hashlib.sha256(output.read_bytes()).hexdigest()
    return {
        "schema_version": 1,
        "archive": {"path": output.name, "bytes": output.stat().st_size, "sha256": digest,
                    "date": date, "name": name},
        "source": {
            "repository": "https://github.com/suttacentral/bilara-data",
            "branch": "published", "commit": source_commit(source),
            "language": language, "root_language": root_language,
            "declared_licenses": {key: len(value)
                                  for key, value in publication_licenses(source).items()},
        },
        "coverage": {
            "declared_texts": len(declared.texts),
            "written_texts": len(written),
            "segments_rendered": segments,
            "unique_uids": len(preferred),
            "redirections": len(preferred),
            "primary_translators": list(PRIMARY_TRANSLATORS),
            "contested_uids": sorted(uid for uid, texts in carried.items() if len(texts) > 1),
            "primary_unranked_uids": sorted(unranked),
            "index_pages": len(by_collection) + 1,
            "by_collection_declared": declared.by_collection(),
            "by_collection_written": {key: len(value) for key, value in by_collection.items()},
            "by_author_declared": declared.by_author(),
        },
        "excluded": {reason: len(paths) for reason, paths in declared.excluded.items()},
        "failures": failures,
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, required=True,
                        help="checkout of suttacentral/bilara-data at its published branch")
    parser.add_argument("--output", type=Path, required=True, help="ZIM archive to write")
    parser.add_argument("--receipt", type=Path, required=True, help="build receipt to write")
    parser.add_argument("--language", default="en")
    parser.add_argument("--root-language", default="pli",
                        help="markup root language admitting a text into the archive")
    parser.add_argument("--date", required=True, help="archive date, YYYY-MM-DD")
    parser.add_argument("--name", default="pali-canon_en_all")
    arguments = parser.parse_args(argv)

    receipt = build(arguments.source, arguments.output, language=arguments.language,
                    root_language=arguments.root_language, date=arguments.date,
                    name=arguments.name)
    arguments.receipt.write_text(json.dumps(receipt, indent=2, ensure_ascii=False) + "\n",
                                 encoding="utf-8")
    coverage = receipt["coverage"]
    print(f"{coverage['written_texts']}/{coverage['declared_texts']} texts, "
          f"{coverage['segments_rendered']} segments, "
          f"{receipt['archive']['bytes']} bytes, sha256 {receipt['archive']['sha256']}")
    if receipt["failures"]:
        print(f"{len(receipt['failures'])} texts failed to render", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
