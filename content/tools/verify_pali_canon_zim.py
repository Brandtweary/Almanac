"""Check that a built Pali-canon ZIM opens, and that every article it claims is retrievable.

A ZIM that is structurally valid but empty passes every cheap test, so the checks here read
content back: each declared text is resolved by path, decoded, extracted through the corpus
reader's own HTML extraction, and compared against the source segments it was built from.

    python tools/verify_pali_canon_zim.py --archive <zim> --receipt <json> --source <checkout>

Exits non-zero, listing every article that failed, when any check does not hold.
"""
from __future__ import annotations

import argparse
import hashlib
import html as html_module
import json
from pathlib import Path
import random
import re
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from pali_canon import survey  # noqa: E402

TAGS = re.compile(r"<[^>]+>")
WHITESPACE = re.compile(r"\s+")
# The source's inline markers carry meaning but no characters of their own, so comparing a
# segment against a rendered article has to drop them on both sides.
INLINE_MARKERS = re.compile(r"[*_#]")
# Canonical text counts that do not depend on how a collection is filed. A build that
# disagrees with these has lost or duplicated discourses, whatever its own totals say.
CANONICAL_TEXT_COUNTS = {"dn": 34, "mn": 152}
# How deep a body-phrase search is paged before an article counts as unreachable.
BODY_SEARCH_WINDOW = 2000


def plain(markup: str) -> str:
    text = html_module.unescape(TAGS.sub(" ", markup))
    return WHITESPACE.sub(" ", INLINE_MARKERS.sub("", text)).strip()


def verify(archive_path: Path, receipt: dict, source: Path, sample: int, seed: int) -> list[str]:
    """Return one message per failed check; an empty list means the archive holds up."""
    from libzim.reader import Archive
    from libzim.search import Query, Searcher
    from oracle_content.extract import html_blocks

    problems: list[str] = []
    declared_archive = receipt["archive"]
    size = archive_path.stat().st_size
    if size != declared_archive["bytes"]:
        problems.append(f"archive is {size} bytes, receipt declares {declared_archive['bytes']}")
    digest = hashlib.sha256(archive_path.read_bytes()).hexdigest()
    if digest != declared_archive["sha256"]:
        problems.append(f"archive sha256 {digest} does not match receipt {declared_archive['sha256']}")

    archive = Archive(str(archive_path))
    if not archive.has_fulltext_index:
        problems.append("archive has no native full-text index")
    written = receipt["coverage"]["written_texts"]
    if archive.article_count != written:
        problems.append(f"archive holds {archive.article_count} articles, receipt declares {written}")

    declared = survey(source, receipt["source"]["language"], receipt["source"]["root_language"])
    if len(declared.texts) != receipt["coverage"]["declared_texts"]:
        problems.append(f"source now declares {len(declared.texts)} texts, receipt declares "
                        f"{receipt['coverage']['declared_texts']}")
    present: dict[str, set[str]] = {}
    for text in declared.texts:
        try:
            entry = archive.get_entry_by_path(text.entry_path)
        except KeyError:
            problems.append(f"{text.entry_path}: absent from archive")
            continue
        if entry.is_redirect:
            problems.append(f"{text.entry_path}: is a redirect, not an article")
            continue
        item = entry.get_item()
        if item.mimetype != "text/html":
            problems.append(f"{text.entry_path}: mimetype {item.mimetype}")
            continue
        content = bytes(item.content).decode("utf-8")
        segments = json.loads(text.translation_path.read_text(encoding="utf-8"))
        body = plain(content)
        missing = [key for key, value in segments.items()
                   if plain(value) and plain(value) not in body]
        if missing:
            problems.append(f"{text.entry_path}: {len(missing)} of {len(segments)} segments "
                            f"absent from the article, first {missing[0]}")
            continue
        present.setdefault(text.collection, set()).add(text.uid)

    for collection, expected in CANONICAL_TEXT_COUNTS.items():
        # Counted over the articles this archive actually yielded, and over distinct uids:
        # a text carried by two translators is two articles but one discourse, and it is
        # the discourses the canon fixes a number for.
        built = len(present.get(collection, ()))
        if built != expected:
            problems.append(f"archive holds {built} complete {collection} discourses, "
                            f"canon has {expected}")

    # Extraction and retrieval are sampled: both are far slower per article than a
    # decode, and a fault in either is a property of the build rather than of one text.
    chosen = random.Random(seed).sample(declared.texts, min(sample, len(declared.texts)))
    # Retrieval cannot be asked of an archive that has already failed the index check.
    searcher = Searcher(archive) if archive.has_fulltext_index else None
    for text in chosen:
        try:
            entry = archive.get_entry_by_path(text.entry_path)
        except KeyError:
            continue
        content = bytes(entry.get_item().content).decode("utf-8")
        blocks = html_blocks(content)
        if not blocks:
            problems.append(f"{text.entry_path}: corpus extraction produced no blocks")
            continue
        if not any(block.text.strip() for block in blocks):
            problems.append(f"{text.entry_path}: corpus extraction produced only empty blocks")
            continue
        if searcher is None:
            continue
        # A text's identifier occurs in that text's own articles and nowhere else, so this
        # settles whether the article reached the full-text index. Which of a text's
        # translations ranks first is a ranking question and not one this check asks.
        identified = list(searcher.search(Query().set_query(text.uid)).getResults(0, 10))
        if text.entry_path not in identified:
            problems.append(f"{text.entry_path}: searching its identifier returned "
                            f"{identified or 'nothing'}")
        longest = max((block.text for block in blocks), key=len)
        phrase = " ".join(longest.split()[:12])
        if len(phrase.split()) < 4:
            continue
        # The canon is formulaic: a stock passage matches hundreds of discourses, so body
        # retrieval is judged on whether the article is reachable, never on where it ranks.
        found = searcher.search(Query().set_query(phrase))
        window = min(max(found.getEstimatedMatches(), 1), BODY_SEARCH_WINDOW)
        if text.entry_path not in list(found.getResults(0, window)):
            problems.append(f"{text.entry_path}: its own longest passage does not retrieve it "
                            f"within {window} results")
    return problems


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--archive", type=Path, required=True)
    parser.add_argument("--receipt", type=Path, required=True)
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--sample", type=int, default=200,
                        help="articles put through extraction and full-text retrieval")
    parser.add_argument("--seed", type=int, default=0)
    arguments = parser.parse_args(argv)

    receipt = json.loads(arguments.receipt.read_text(encoding="utf-8"))
    problems = verify(arguments.archive, receipt, arguments.source, arguments.sample, arguments.seed)
    if problems:
        print(f"{len(problems)} checks failed:", file=sys.stderr)
        for problem in problems[:50]:
            print(f"  {problem}", file=sys.stderr)
        if len(problems) > 50:
            print(f"  … and {len(problems) - 50} more", file=sys.stderr)
        return 1
    print(f"{receipt['coverage']['written_texts']} articles verified: every declared text is "
          f"retrievable and complete; extraction and retrieval sampled at {arguments.sample}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
