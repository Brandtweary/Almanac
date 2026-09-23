"""Build a searchable text archive from the Survivor Library crawl's scanned books.

The crawl's books are PDF entries, and the crawl's own full-text index covers only its HTML
navigation, so without this every book is invisible to search. This reads each book's text
and writes one HTML article per book into a natively indexed ZIM, at the same entry path the
PDF has in the crawl. The crawl is retained whole: an article's path names the scan it came
from, and the archive's `Scans` metadata names the crawl by its SHA-256.

    python tools/build_survivor_text_zim.py --crawl survivorlibrary.com_en_all_2025-12.zim \\
        --crawl-sha256 <sha256> --work <ledger directory> \\
        --output survivor-library-text_en_all_2025-12.zim --receipt receipt.json

Text comes from, in order:

1. the PDF's own text layer, where one covers most of its pages;
2. the Internet Archive's OCR of the same scan, for a PDF without one: through the
   archive.org identifier the PDF embeds, else through a search by title and year that is
   admitted only when the title's words, the year, any volume or part number and the page
   count all agree with the scan;
3. otherwise a partial text layer, when the PDF has some text but not enough to pass (1).

A book none of these reach is counted as image-only and written into no article. Every
article states which source its text came from. Work resumes from the ledger in `--work`:
a book read or looked up once is never read or fetched again, so an interrupted run
continues where it stopped. `--offline` skips the Internet Archive phase.
"""
from __future__ import annotations

import argparse
from concurrent.futures import ProcessPoolExecutor, ThreadPoolExecutor, as_completed
from concurrent.futures.process import BrokenProcessPool
import html
import json
import os
from pathlib import Path
import re
import sqlite3
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import zlib

sys.path.insert(0, str(Path(__file__).resolve().parent))

# A page carries text when it holds at least this many non-space characters; below it the
# layer is scanner noise around an image.
PAGE_TEXT_CHARACTERS = 40
# The share of pages that must carry text for a PDF's layer to count as the book's text.
TEXT_LAYER_SHARE = 0.5
# A partial layer still becomes an article when nothing better exists and it holds this much.
PARTIAL_TEXT_CHARACTERS = 2000
# The Internet Archive counts scan images, the PDF counts pages, and the two differ by the
# covers, colour cards and blank leaves one side kept and the other dropped.
PAGE_COUNT_TOLERANCE = 0.12
PAGE_COUNT_SLACK = 12

IA_SEARCH = "https://archive.org/advancedsearch.php"
IA_METADATA = "https://archive.org/metadata/"
IA_DOWNLOAD = "https://archive.org/download/"
USER_AGENT = "Almanac survivor-text builder (+https://github.com/Brandtweary/Almanac)"
EMBEDDED_IDENTIFIER = re.compile(r"archive\.org/details/([A-Za-z0-9._-]+)")

STOPWORDS = frozenset("a an and as at by for from in into of on or the to with".split())
# A volume, part or number designation, in arabic numerals or, after a separator, roman.
NUMBERED = re.compile(r"\b(vol|volume|v|part|pt|no|number|book|bk)(?:\.?[ ._]*(\d+)|\.?[ ._]+([ivxlc]+))\b", re.I)
ROMAN = {"i": 1, "v": 5, "x": 10, "l": 50, "c": 100}
# Scanner watermarks the Internet Archive's OCR keeps as text lines.
WATERMARK = re.compile(r"^(?:digiti[sz]?e?d?|zed by|digitized by|digit!|d\s?i\s?g\s?i\s?t)\b.*$|^.{0,4}google\s*$", re.I)


def words(text: str) -> list[str]:
    return re.findall(r"[a-z0-9]+", text.lower())


def title_and_year(name: str) -> tuple[str, str | None]:
    """A crawl file name such as `a_compendium_of_mechanics_1830` as a title and a year."""
    stem = re.sub(r"\.pdf$", "", name, flags=re.I)
    match = re.match(r"(.*?)[_ -]+(\d{4})$", stem)
    stem, year = (match[1], match[2]) if match else (stem, None)
    title = " ".join(part.capitalize() if part.islower() else part for part in re.split(r"[_ ]+", stem) if part)
    return title, year


def numbered_parts(text: str) -> set[tuple[str, str]]:
    """The volume, part and number designations a title carries, normalized."""
    kinds = {"vol": "vol", "volume": "vol", "v": "vol", "part": "part", "pt": "part",
             "no": "no", "number": "no", "book": "book", "bk": "book"}
    spaced = re.sub(r"[_.]", " ", text)
    return {(kinds[kind.lower()], str(int(arabic) if arabic else roman_value(roman)))
            for kind, arabic, roman in NUMBERED.findall(spaced)}


def roman_value(numeral: str) -> int:
    values = [ROMAN[character] for character in numeral.lower()]
    return sum(-value if value < following else value for value, following in zip(values, values[1:] + [0]))


def significant(text: str) -> set[str]:
    return {word for word in words(re.sub(NUMBERED, " ", re.sub(r"[_.]", " ", text)))
            if word not in STOPWORDS and not re.fullmatch(r"\d{4}", word)}


def admit_candidate(title: str, year: str | None, pages: int, candidate: dict) -> str | None:
    """Why an Internet Archive item is not this scan, or None when it is admitted.

    A wrong match puts another book's words under this book's title and citation, so every
    check refuses rather than guesses: the year must be equal, every significant word of the
    crawl's title must appear in the item's, a volume, part or number the crawl's title
    carries must appear in the item's title or volume field, and the item's scan must be
    within tolerance of the PDF's page count.
    """
    if not year or str(candidate.get("year", ""))[:4] != year:
        return "year"
    item_title = str(candidate.get("title", ""))
    if not significant(title) <= set(words(item_title)):
        return "title"
    wanted = numbered_parts(title)
    if wanted:
        offered = numbered_parts(item_title + " " + " ".join(f"vol {v}" for v in re.findall(r"\d+", str(candidate.get("volume", "")))))
        numbers = set(words(item_title)) | set(re.findall(r"\d+", str(candidate.get("volume", ""))))
        for kind, number in wanted:
            if (kind, number) not in offered and not (kind == "vol" and number in numbers):
                return "volume"
    try:
        images = int(candidate.get("imagecount"))
    except (TypeError, ValueError):
        return "page_count_unknown"
    if abs(images - pages) > max(PAGE_COUNT_SLACK, PAGE_COUNT_TOLERANCE * pages):
        return "page_count"
    return None


def paragraphs_from_lines(lines: list[str]) -> list[str]:
    """Join a page's text lines into paragraphs.

    A text layer carries lines and no paragraph marks. A line markedly shorter than the
    page's full lines ends a paragraph, and a word hyphenated across a line break is joined.
    """
    lines = [line.strip() for line in lines]
    lines = [line for line in lines if line]
    if not lines:
        return []
    widths = sorted(len(line) for line in lines)
    full = widths[int(0.9 * (len(widths) - 1))]
    out, current = [], ""
    for line in lines:
        if current.endswith("-") and line[:1].islower():
            current = current[:-1] + line
        else:
            current = f"{current} {line}" if current else line
        if len(line) < 0.6 * full:
            out.append(current)
            current = ""
    if current:
        out.append(current)
    return out


def clean_archive_text(text: str) -> list[str]:
    """Paragraphs of an Internet Archive `_djvu.txt`, without scanner watermark lines."""
    out = []
    for block in re.split(r"\n\s*\n", text):
        lines = [line.strip() for line in block.splitlines()]
        lines = [line for line in lines if line and not WATERMARK.match(line)]
        joined = ""
        for line in lines:
            if joined.endswith("-") and line[:1].islower():
                joined = joined[:-1] + line
            else:
                joined = f"{joined} {line}" if joined else line
        if len(joined) > 2 and re.search(r"[A-Za-z]{2}", joined):
            out.append(joined)
    return strip_scanner_notice(out)


def strip_scanner_notice(paragraphs: list[str]) -> list[str]:
    """Drop the usage notice Google Books prefixes to its scans, which OCR reads as text.

    Left in, every such book answers searches about copyright and public domain with the
    same boilerplate. The notice runs from its opening sentence to Google's own address.
    """
    head = paragraphs[:80]
    start = next((i for i, p in enumerate(head) if p.startswith("This is a digital copy of a book that was preserved")), None)
    if start is None:
        return paragraphs
    end = next((i for i, p in enumerate(head[start:start + 30], start)
                if re.search(r"books\s*\.\s*google\s*\.\s*com", p)), None)
    return paragraphs if end is None else paragraphs[:start] + paragraphs[end + 1:]


# --- ledger ---------------------------------------------------------------------------

SCHEMA = """
CREATE TABLE IF NOT EXISTS books (
    path TEXT PRIMARY KEY, entry INTEGER NOT NULL, pages INTEGER, text_pages INTEGER,
    characters INTEGER, identifier TEXT, layer BLOB, status TEXT NOT NULL, detail TEXT);
CREATE TABLE IF NOT EXISTS archive (
    path TEXT PRIMARY KEY, identifier TEXT, text BLOB, status TEXT NOT NULL, detail TEXT);
CREATE TABLE IF NOT EXISTS facts (key TEXT PRIMARY KEY, value TEXT NOT NULL);
"""


def ledger(work: Path) -> sqlite3.Connection:
    work.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(work / "ledger.sqlite", timeout=60)
    db.executescript(SCHEMA)
    return db


def pack(value) -> bytes:
    return zlib.compress(json.dumps(value, ensure_ascii=False).encode("utf-8"), 6)


def unpack(blob: bytes):
    return json.loads(zlib.decompress(blob))


# --- phase 1: the PDFs' own text layers ------------------------------------------------

_archive = None


def _open(crawl: str):
    global _archive
    if _archive is None or _archive[0] != crawl:
        from libzim.reader import Archive
        _archive = (crawl, Archive(crawl))
    return _archive[1]


def read_pdf(crawl: str, entry: int) -> dict:
    """One book's text layer, page by page, and any archive.org identifier it embeds."""
    import pypdfium2 as pdfium
    item = _open(crawl)._get_entry_by_id(entry).get_item()
    document = pdfium.PdfDocument(bytes(item.content))
    try:
        pages, identifier = [], None
        for page in document:
            text = page.get_textpage().get_text_range()
            pages.append(text)
            if identifier is None:
                found = EMBEDDED_IDENTIFIER.search(text)
                identifier = found[1] if found else None
        if identifier is None:
            metadata = " ".join(str(value) for value in document.get_metadata_dict().values())
            found = EMBEDDED_IDENTIFIER.search(metadata)
            identifier = found[1] if found else None
    finally:
        document.close()
    text_pages = sum(len("".join(text.split())) >= PAGE_TEXT_CHARACTERS for text in pages)
    return {"pages": len(pages), "text_pages": text_pages,
            "characters": sum(len(text.strip()) for text in pages), "identifier": identifier,
            "layer": [paragraphs_from_lines(re.split(r"\r?\n", text)) for text in pages]}


def pdf_entries(crawl: str) -> list[tuple[str, int]]:
    archive = _open(crawl)
    found = []
    for index in range(archive.entry_count):
        entry = archive._get_entry_by_id(index)
        if not entry.is_redirect and entry.get_item().mimetype.split(";")[0].strip() == "application/pdf":
            found.append((entry.path, index))
    return found


def read_layers(crawl: Path, db: sqlite3.Connection, workers: int, log) -> None:
    known = {row[0] for row in db.execute("SELECT path FROM books")}
    pending = [(path, entry) for path, entry in pdf_entries(str(crawl)) if path not in known]
    log(f"read: {len(known)} books already read, {len(pending)} to read")

    def record(path, entry, result=None, error=None):
        if error is not None:
            db.execute("INSERT OR REPLACE INTO books(path, entry, status, detail) VALUES(?,?,?,?)",
                       (path, entry, "unreadable", error))
            return
        share = result["text_pages"] / result["pages"] if result["pages"] else 0
        status = "text_layer" if share >= TEXT_LAYER_SHARE else "partial_layer" if result["characters"] >= PARTIAL_TEXT_CHARACTERS else "image_only"
        db.execute("INSERT OR REPLACE INTO books VALUES(?,?,?,?,?,?,?,?,?)",
                   (path, entry, result["pages"], result["text_pages"], result["characters"],
                    result["identifier"], pack(result["layer"]), status, None))

    started, done = time.time(), 0
    queue = list(pending)
    while queue:
        suspects = []
        with ProcessPoolExecutor(max_workers=workers) as executor:
            futures = {executor.submit(read_pdf, str(crawl), entry): (path, entry) for path, entry in queue}
            queue = []
            try:
                for future in as_completed(futures):
                    path, entry = futures.pop(future)
                    try:
                        record(path, entry, future.result())
                    except BrokenProcessPool:
                        raise
                    except Exception as error:  # A malformed PDF is one book's failure.
                        record(path, entry, error=f"{type(error).__name__}: {error}")
                    done += 1
                    if done % 200 == 0:
                        db.commit()
                        rate = done / (time.time() - started)
                        log(f"read: {done}/{len(pending)} at {rate:.1f} books/s")
            except BrokenProcessPool:
                # A native crash takes the pool with it and cannot name its book, so every
                # unrecorded book is retried alone; the one that crashes alone is recorded.
                suspects = list(futures.values())
        db.commit()
        for path, entry in suspects:
            with ProcessPoolExecutor(max_workers=1) as single:
                try:
                    record(path, entry, single.submit(read_pdf, str(crawl), entry).result())
                except BrokenProcessPool:
                    record(path, entry, error="extractor crashed on this PDF")
                except Exception as error:
                    record(path, entry, error=f"{type(error).__name__}: {error}")
            done += 1
        db.commit()


# --- phase 2: the Internet Archive's OCR of the same scans ----------------------------

def fetch(url: str, *, attempts: int = 5, limit: int = 256 * 1024 * 1024) -> bytes:
    delay = 2.0
    for attempt in range(attempts):
        try:
            request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
            with urllib.request.urlopen(request, timeout=90) as response:
                body = response.read(limit + 1)
            if len(body) > limit:
                raise ValueError("response exceeds its limit")
            return body
        except urllib.error.HTTPError as error:
            if error.code in (400, 401, 403, 404, 410):
                raise
            last = error
        except (urllib.error.URLError, TimeoutError, ConnectionError, OSError) as error:
            last = error
        time.sleep(delay)
        delay = min(delay * 2, 60)
    raise last


def archive_metadata(identifier: str) -> dict:
    return json.loads(fetch(IA_METADATA + urllib.parse.quote(identifier)))


def archive_text(identifier: str, metadata: dict) -> str:
    names = [f["name"] for f in metadata.get("files", []) if f.get("name", "").endswith("_djvu.txt")]
    if not names:
        raise LookupError("item has no OCR text")
    preferred = f"{identifier}_djvu.txt"
    name = preferred if preferred in names else names[0]
    return fetch(IA_DOWNLOAD + urllib.parse.quote(identifier) + "/" + urllib.parse.quote(name)).decode("utf-8", "replace")


def find_scan(title: str, year: str | None, pages: int) -> tuple[str | None, str]:
    """The Internet Archive item holding this scan, or None and why none was admitted."""
    terms = sorted(significant(title))
    if not terms or not year:
        return None, "no_search_terms"
    query = f"title:({' AND '.join(terms)}) AND year:{year} AND mediatype:texts"
    url = IA_SEARCH + "?" + urllib.parse.urlencode(
        {"q": query, "fl[]": ["identifier", "title", "year", "volume", "imagecount"], "rows": 25, "output": "json"}, doseq=True)
    docs = json.loads(fetch(url))["response"]["docs"]
    refusals = {}
    admitted = []
    for doc in docs:
        reason = admit_candidate(title, year, pages, doc)
        if reason is None:
            admitted.append(doc)
        else:
            refusals[reason] = refusals.get(reason, 0) + 1
    if not admitted:
        return None, "no_admitted_candidate " + json.dumps(refusals, sort_keys=True) if docs else "no_candidates"
    # The Google Books scans the crawl mostly carries were uploaded to the Internet Archive
    # under identifiers ending in `goog`; among admitted items, the nearest page count wins.
    admitted.sort(key=lambda doc: (abs(int(doc["imagecount"]) - pages), not doc["identifier"].endswith("goog"), doc["identifier"]))
    return admitted[0]["identifier"], "search"


def look_up(path: str, pages: int, identifier: str | None) -> tuple[str | None, str | None, str, str]:
    title, year = title_and_year(Path(path).name)
    how = "embedded_identifier"
    if identifier is None:
        identifier, how = find_scan(title, year, pages)
        if identifier is None:
            return None, None, "not_found", how
    metadata = archive_metadata(identifier)
    if how == "embedded_identifier" and not metadata.get("metadata"):
        return None, None, "not_found", "embedded identifier unknown to the Internet Archive"
    try:
        text = archive_text(identifier, metadata)
    except LookupError as error:
        return identifier, None, "not_found", str(error)
    except urllib.error.HTTPError as error:
        if error.code not in (403, 404, 410):
            raise
        return identifier, None, "not_found", f"OCR text unavailable (HTTP {error.code})"
    if len(text.strip()) < PARTIAL_TEXT_CHARACTERS:
        return identifier, None, "not_found", "OCR text too short"
    return identifier, text, "found", how


def consult_archive(db: sqlite3.Connection, workers: int, log) -> None:
    done = {row[0] for row in db.execute("SELECT path FROM archive WHERE status != 'error'")}
    pending = [(path, pages, identifier) for path, pages, identifier in db.execute(
        "SELECT path, pages, identifier FROM books WHERE status IN ('image_only', 'partial_layer')") if path not in done]
    log(f"internet-archive: {len(done)} already consulted, {len(pending)} to consult")
    started = time.time()
    with ThreadPoolExecutor(max_workers=workers) as pool:
        futures = {pool.submit(look_up, path, pages, identifier): path for path, pages, identifier in pending}
        for count, future in enumerate(as_completed(futures), 1):
            path = futures[future]
            try:
                identifier, text, status, detail = future.result()
                db.execute("INSERT OR REPLACE INTO archive VALUES(?,?,?,?,?)",
                           (path, identifier, pack(text) if text else None, status, detail))
            except Exception as error:  # Recorded as an error and retried on the next run.
                db.execute("INSERT OR REPLACE INTO archive VALUES(?,?,?,?,?)",
                           (path, None, None, "error", f"{type(error).__name__}: {error}"))
            if count % 50 == 0:
                db.commit()
                log(f"internet-archive: {count}/{len(pending)} at {count / (time.time() - started):.2f} books/s")
    db.commit()


# --- phase 3: the text archive --------------------------------------------------------

def categories(crawl: str) -> dict[str, list[str]]:
    """The library categories each PDF is listed under, read from the crawl's own pages."""
    from bs4 import BeautifulSoup
    archive = _open(crawl)
    listed: dict[str, list[str]] = {}
    for index in range(archive.entry_count):
        entry = archive._get_entry_by_id(index)
        if entry.is_redirect or not entry.get_item().mimetype.startswith("text/html"):
            continue
        soup = BeautifulSoup(bytes(entry.get_item().content).decode("utf-8", "replace"), "html.parser")
        # A category page names itself in its title ("Medical_Obstetrics_1900-1922 | Survivor
        # Library"); a table may also carry the name as its accessible label.
        page = (soup.title.get_text() if soup.title else "").split("|")[0]
        for table in soup.find_all("table"):
            label = table.get("aria-label") or page
            name = re.sub(r"^Library[-_ ]*", "", label).replace("_", " ").strip()
            if not name:
                continue
            for link in table.find_all("a", href=True):
                if link["href"].lower().endswith(".pdf"):
                    key = urllib.parse.unquote(link["href"].rsplit("/", 1)[-1]).lower()
                    if name not in listed.setdefault(key, []):
                        listed[key].append(name)
    return listed


def render(path: str, pages: int, category: list[str], source: str, detail: str, body: list[tuple[str | None, list[str]]]) -> tuple[str, str]:
    title, year = title_and_year(Path(path).name)
    heading = f"{title} ({year})" if year else title
    where = f" Listed under {', '.join(category)}." if category else ""
    # The opening paragraph is the lead a book's one vector represents, so it names the
    # book and its subject; where the text came from follows under its own heading.
    intro = f"{heading}. A {pages}-page scanned book in the Survivor Library.{where}"
    parts = [f"<h1>{html.escape(heading)}</h1>", f"<p>{html.escape(intro)}</p>",
             "<h2>About this text</h2>", f"<p>{html.escape(detail)}</p>"]
    for label, paragraphs in body:
        if label:
            parts.append(f"<h2>{html.escape(label)}</h2>")
        parts.extend(f"<p>{html.escape(paragraph)}</p>" for paragraph in paragraphs)
    document = ('<!DOCTYPE html>\n<html lang="en"><head><meta charset="utf-8"><title>'
                + html.escape(heading) + "</title></head><body>" + "".join(parts) + "</body></html>")
    return heading, document


def write_archive(crawl: Path, crawl_sha256: str, db: sqlite3.Connection, output: Path, log) -> dict:
    from libzim.writer import Creator, Hint, Item, StringProvider
    from build_pali_canon_zim import illustration

    class Article(Item):
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

    source_archive = _open(str(crawl))
    date = bytes(source_archive.get_metadata("Date")).decode() if "Date" in source_archive.metadata_keys else time.strftime("%Y-%m-%d")
    listed = categories(str(crawl))
    looked_up = {row[0]: row[1:] for row in db.execute("SELECT path, identifier, text, status, detail FROM archive")}
    counts: dict[str, int] = {}
    characters: dict[str, int] = {}
    pages_total = 0
    unreadable = []
    temporary = output.with_name(output.name + ".building")
    temporary.unlink(missing_ok=True)
    with Creator(str(temporary)).config_indexing(True, "eng") as creator:
        for name, value in {
            "Name": "survivor-library-text_en_all", "Title": "Survivor Library, book text",
            "Creator": "Survivor Library", "Publisher": "Almanac", "Date": date, "Language": "eng",
            "Description": "The text of the Survivor Library's scanned books, one article per book.",
            "LongDescription": ("Each article holds one book's text, read from the scan's own text layer or "
                                "from the Internet Archive's OCR of the same scan, and sits at the path the "
                                "scan has in the Survivor Library crawl named by the Scans metadata."),
            "Source": "https://www.survivorlibrary.com/", "Scraper": "almanac build_survivor_text_zim",
            "Scans": crawl_sha256,
        }.items():
            creator.add_metadata(name, value)
        creator.add_illustration(48, illustration())
        rows = db.execute("SELECT path, pages, text_pages, identifier, layer, status, detail FROM books ORDER BY path")
        for path, pages, text_pages, _identifier, layer, status, detail in rows:
            category = listed.get(urllib.parse.unquote(path.rsplit("/", 1)[-1]).lower(), [])
            if status == "unreadable":
                counts["unreadable"] = counts.get("unreadable", 0) + 1
                unreadable.append({"path": path, "error": detail})
                continue
            pages_total += pages
            found = looked_up.get(path)
            if status == "text_layer":
                source = "text_layer"
                detail_text = "Its text is the scan's own text layer; each page heading is the scan's page number."
                body = [(f"Page {number}", paragraphs) for number, paragraphs in enumerate(unpack(layer), 1) if paragraphs]
            elif found and found[2] == "found":
                source = "internet_archive"
                identifier, text, _status, how = found
                basis = ("the archive.org identifier the scan embeds" if how == "embedded_identifier"
                         else "its title, year, volume and page count")
                digitized = " The scan was digitized by Google Books." if identifier.endswith("goog") else ""
                detail_text = (f"Its text is the Internet Archive's OCR of scan {identifier} "
                               f"(https://archive.org/details/{identifier}), matched to this book by {basis}; "
                               f"it carries no page breaks.{digitized}")
                body = [("Text", clean_archive_text(unpack(text)))]
            elif status == "partial_layer":
                source = "partial_text_layer"
                detail_text = (f"Its text is the scan's own text layer, which covers {text_pages} of its "
                               f"{pages} pages; each page heading is the scan's page number.")
                body = [(f"Page {number}", paragraphs) for number, paragraphs in enumerate(unpack(layer), 1) if paragraphs]
            else:
                counts["image_only"] = counts.get("image_only", 0) + 1
                continue
            heading, document = render(path, pages, category, source, detail_text, body)
            creator.add_item(Article(path, heading, document))
            counts[source] = counts.get(source, 0) + 1
            characters[source] = characters.get(source, 0) + sum(len(p) for _label, ps in body for p in ps)
    os.replace(temporary, output)
    total = sum(counts.values())
    written = sum(counts.get(key, 0) for key in ("text_layer", "internet_archive", "partial_text_layer"))
    archive_outcomes: dict[str, int] = {}
    for _identifier, _text, status, detail in looked_up.values():
        key = status if status != "not_found" else "not_found:" + (detail or "").split(" ")[0]
        archive_outcomes[key] = archive_outcomes.get(key, 0) + 1
    return {"crawl": {"path": crawl.name, "sha256": crawl_sha256, "pdf_entries": total},
            "articles": written, "by_source": counts, "characters_by_source": characters,
            "pages_in_crawl_pdfs": pages_total, "article_share": round(written / total, 4) if total else 0,
            "internet_archive_outcomes": archive_outcomes, "unreadable": unreadable,
            "archive": {"path": output.name, "bytes": output.stat().st_size}}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--crawl", type=Path, required=True, help="the Survivor Library crawl ZIM")
    parser.add_argument("--crawl-sha256", required=True, help="the crawl's pinned SHA-256, recorded as the text archive's Scans")
    parser.add_argument("--work", type=Path, required=True, help="ledger directory; a rerun resumes from it")
    parser.add_argument("--output", type=Path, required=True, help="text ZIM to write")
    parser.add_argument("--receipt", type=Path, required=True, help="build receipt to write")
    parser.add_argument("--workers", type=int, default=max(1, (os.cpu_count() or 2) // 2))
    parser.add_argument("--internet-archive-workers", type=int, default=4)
    parser.add_argument("--offline", action="store_true", help="skip the Internet Archive phase")
    parser.add_argument("--phase", choices=("all", "read", "internet-archive", "write"), default="all")
    arguments = parser.parse_args(argv)
    if not re.fullmatch(r"[0-9a-f]{64}", arguments.crawl_sha256):
        parser.error("--crawl-sha256 must be a lowercase hex SHA-256")

    def log(message):
        print(time.strftime("%H:%M:%S"), message, flush=True)

    db = ledger(arguments.work)
    if arguments.phase in ("all", "read"):
        read_layers(arguments.crawl, db, arguments.workers, log)
    if arguments.phase in ("all", "internet-archive") and not arguments.offline:
        consult_archive(db, arguments.internet_archive_workers, log)
    if arguments.phase in ("all", "write"):
        receipt = write_archive(arguments.crawl, arguments.crawl_sha256, db, arguments.output, log)
        arguments.receipt.write_text(json.dumps(receipt, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
        log(f"wrote {receipt['articles']} articles of {receipt['crawl']['pdf_entries']} books: {receipt['by_source']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
