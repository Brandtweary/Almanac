"""The Internet Archive match that puts OCR text under a scanned book's title."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "tools"))

from build_survivor_text_zim import admit_candidate, title_and_year  # noqa: E402


def test_only_the_same_scan_is_admitted_as_a_books_text():
    """A wrong match files another book's words under this book's title and citation,
    so a candidate differing in year, title, volume or scan length is refused."""
    title, year = title_and_year("a_treatise_on_chemistry_vol_3_part_2_1884.pdf")
    assert (title, year) == ("A Treatise On Chemistry Vol 3 Part 2", "1884")
    same = {"title": "A treatise on chemistry. Vol. III, part II", "year": "1884", "imagecount": 700}
    assert admit_candidate(title, year, 667, same) is None
    assert admit_candidate(title, year, 667, {**same, "title": "A treatise on chemistry. Vol. I"}) == "volume"
    assert admit_candidate(title, year, 667, {**same, "year": "1891"}) == "year"
    assert admit_candidate(title, year, 667, {**same, "title": "A treatise on metallurgy. Vol. 3, part 2"}) == "title"
    assert admit_candidate(title, year, 667, {**same, "imagecount": 180}) == "page_count"
    assert admit_candidate(title, year, 667, {**same, "imagecount": None}) == "page_count_unknown"
