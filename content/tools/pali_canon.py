"""Render SuttaCentral's segmented Pali-canon data into ZIM articles.

The source is one JSON object per text, keyed by segment identifier. Each text has a
cognate markup file under `html/<root>/<edition>/` holding, for the same keys, an HTML
template carrying exactly one `{}` placeholder. An article is those templates joined in
file order with their translated segment substituted in.

Segment strings themselves carry a small inline vocabulary: a markdown subset with
source-specific meanings, and a short allowlist of literal HTML tags. Everything outside
that vocabulary is escaped.
"""
from __future__ import annotations

from dataclasses import dataclass, field
import json
from pathlib import Path
import re

# Tags the source writes literally inside segment strings. Anything else that looks like
# markup is content and is escaped.
INLINE_TAGS = ("em", "i", "b", "strong", "a", "span", "j", "sup", "sub")
RAW_TAG = re.compile(r"</?(?:" + "|".join(INLINE_TAGS) + r")\b[^>]*>", re.I)
JOIN_TAG = re.compile(r"<j\s*/?>", re.I)

STRONG = re.compile(r"\*\*(.+?)\*\*", re.S)
EMPHASIS = re.compile(r"\*(.+?)\*", re.S)
ROOT_QUOTE = re.compile(r"_(.+?)_", re.S)
COUNTER = re.compile(r"#(\d+)")

PLACEHOLDER = "{}"
SEGMENT_KEY = re.compile(r"^(?P<uid>.+?):(?P<position>.+)$")


class SourceError(Exception):
    """The source data does not match the contract this renderer depends on."""


def _escape_text(span: str) -> str:
    return span.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def _inline_markup(span: str) -> str:
    span = STRONG.sub(r"<strong>\1</strong>", span)
    span = EMPHASIS.sub(r"<em>\1</em>", span)
    span = ROOT_QUOTE.sub(r"<i lang='pi' translate='no'>\1</i>", span)
    return COUNTER.sub(r"<span class='counter'>\1</span>", span)


def inline(text: str) -> str:
    """Escape a segment string while preserving the markup its source vocabulary defines."""
    out, cursor = [], 0
    for match in RAW_TAG.finditer(text):
        out.append(_inline_markup(_escape_text(text[cursor:match.start()])))
        # A join marker divides two lines of verse; every other allowlisted tag is passed through.
        out.append("<br>" if JOIN_TAG.fullmatch(match.group(0)) else match.group(0))
        cursor = match.end()
    out.append(_inline_markup(_escape_text(text[cursor:])))
    return "".join(out)


def render_segments(translation: dict[str, str], markup: dict[str, str]) -> str:
    """Substitute each segment into its markup template, in the translation's own order."""
    parts = []
    for key, value in translation.items():
        template = markup.get(key)
        if template is None:
            raise SourceError(f"segment {key} has no markup template")
        if template.count(PLACEHOLDER) != 1:
            raise SourceError(f"segment {key} template does not carry exactly one placeholder")
        parts.append(template.replace(PLACEHOLDER, inline(value)))
    return "".join(parts)


@dataclass(frozen=True)
class Text:
    """One translated text: where its parts live and how it is identified."""
    uid: str
    author: str
    language: str
    collection: str
    translation_path: Path
    markup_path: Path
    markup_root: str

    @property
    def entry_path(self) -> str:
        return f"suttacentral.net/{self.uid}/{self.language}/{self.author}"

    @property
    def source_url(self) -> str:
        return f"https://{self.entry_path}"


@dataclass
class Survey:
    """What the source declares, before anything is rendered."""
    texts: list[Text] = field(default_factory=list)
    excluded: dict[str, list[str]] = field(default_factory=dict)

    def by_collection(self) -> dict[str, int]:
        counts: dict[str, int] = {}
        for text in self.texts:
            counts[text.collection] = counts.get(text.collection, 0) + 1
        return counts

    def by_author(self) -> dict[str, int]:
        counts: dict[str, int] = {}
        for text in self.texts:
            counts[text.author] = counts.get(text.author, 0) + 1
        return counts


def _markup_roots(source: Path) -> list[Path]:
    return sorted(path for path in source.glob("html/*/*") if path.is_dir())


def restricted_paths(source: Path, dedication: str = "CC0") -> list[str]:
    """Translation directories whose publication record declares something other than CC0.

    The source repository dedicates its translations to the public domain, but individual
    publications may carry their own terms, and a record names the directory it governs.
    Refusing those directories by rule keeps a differently-licensed text out of the archive
    whether or not some other rule would have happened to exclude it.

    A record that declares something other than the dedication but does not say which
    directory it governs cannot be honoured, and is refused rather than skipped: the
    alternative is a differently-licensed text entering the archive because the one rule
    meant to stop it could not read its own input.
    """
    records = json.loads((source / "_publication.json").read_text(encoding="utf-8"))
    restricted, unplaceable = [], []
    for number, record in records.items():
        license = (record.get("license") or {}).get("license_abbreviation")
        if license == dedication:
            continue
        url = record.get("source_url") or ""
        _, separator, path = url.partition("/published/")
        path = path.rstrip("/")
        if separator and path.startswith("translation/"):
            restricted.append(path)
        elif separator and path.startswith("root/"):
            # Root texts are never carried by this archive, so a record governing one
            # restricts nothing and needs no directory of its own.
            continue
        else:
            unplaceable.append(f"{number} ({license or 'no license'}): source_url {url!r}")
    if unplaceable:
        raise SourceError(
            "publication records declare terms other than " + dedication
            + " but name no translation directory to exclude: " + "; ".join(sorted(unplaceable)))
    return sorted(restricted)


def survey(source: Path, language: str, root_language: str) -> Survey:
    """Enumerate every translation whose markup cognate belongs to the wanted root language.

    A translation is in scope only when its cognate exists and its publication carries the
    public-domain dedication, so the scope is decided by the source data rather than by a
    hand-kept list of collections.
    """
    result = Survey()
    restricted = restricted_paths(source)
    roots = _markup_roots(source)
    if not roots:
        raise SourceError(f"no markup directories under {source / 'html'}")
    base = source / "translation" / language
    if not base.is_dir():
        raise SourceError(f"no translations for language {language!r} under {source}")
    for author_dir in sorted(path for path in base.iterdir() if path.is_dir()):
        author = author_dir.name
        suffix = f"_translation-{language}-{author}"
        for translation_path in sorted(author_dir.rglob("*.json")):
            relative = translation_path.relative_to(author_dir)
            # `name/` holds title tables keyed by uid, not texts.
            if relative.parts[0] == "name":
                continue
            posix = translation_path.relative_to(source).as_posix()
            governing = next((path for path in restricted if posix.startswith(path + "/")), None)
            if governing is not None:
                result.excluded.setdefault("not_public_domain", []).append(str(relative))
                continue
            cognate = Path(str(relative).replace(suffix, "_html"))
            match = next((root for root in roots if (root / cognate).is_file()), None)
            if match is None:
                result.excluded.setdefault("no_markup_cognate", []).append(str(relative))
                continue
            root = match.relative_to(source / "html").parts[0]
            if root != root_language:
                result.excluded.setdefault(f"root_language_{root}", []).append(str(relative))
                continue
            result.texts.append(Text(
                uid=translation_path.name.split(suffix)[0],
                author=author,
                language=language,
                # The sutta basket is filed by nikaya; every other basket is one collection.
                collection=relative.parts[1] if relative.parts[0] == "sutta" and len(relative.parts) > 2
                           else relative.parts[0],
                translation_path=translation_path,
                markup_path=match / cognate,
                markup_root=match.relative_to(source / "html").as_posix(),
            ))
    return result


def title_table(source: Path, language: str) -> dict[str, str]:
    """Map each uid to its translated title, from the per-collection name tables."""
    titles: dict[str, str] = {}
    base = source / "translation" / language
    for path in sorted(base.glob("*/name/**/*.json")):
        for key, value in json.loads(path.read_text(encoding="utf-8")).items():
            match = SEGMENT_KEY.match(key)
            if match is None:
                continue
            # A name key reads `<table>-name:<ordinal>.<uid>`.
            uid = match["position"].split(".", 1)[-1]
            titles.setdefault(uid, value.strip())
    return titles


def publication_licenses(source: Path) -> dict[str, list[str]]:
    """Read each published text's declared license from the source's publication records."""
    path = source / "_publication.json"
    records = json.loads(path.read_text(encoding="utf-8"))
    licenses: dict[str, list[str]] = {}
    for record in records.values():
        abbreviation = (record.get("license") or {}).get("license_abbreviation")
        if abbreviation:
            licenses.setdefault(abbreviation, []).append(record.get("text_uid", ""))
    return licenses
