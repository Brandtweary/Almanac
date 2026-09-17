import pytest

from oracle_content.extract import html_blocks
from oracle_content.native import article_lead


SOURCE = '<p>Area: 12 m<sup>2</sup>. Concentration: 10<sup>−3</sup> mol/L. Formula: H<sub>2</sub>O.</p>'
EXPECTED = 'Area: 12 m^(2). Concentration: 10^(−3) mol/L. Formula: H_(2)O.'


def test_paragraph_and_lead_keep_superscript_and_subscript_semantics():
    rows = html_blocks('<main>' + SOURCE + '</main>')
    assert rows[0].text == EXPECTED
    assert article_lead('<div class="mw-parser-output">' + SOURCE + '</div>', 1000) == EXPECTED
    assert not rows[0].flags


def test_table_cells_and_reference_superscripts_are_distinct_from_math():
    rows = html_blocks('<table><tr><th>Quantity</th><th>Value</th></tr><tr><td>Area</td><td>12 m<sup>2</sup><sup class="reference">[3]</sup></td></tr></table>')
    assert 'Area | 12 m^(2)[3]' in rows[0].text
    assert '^([3])' not in rows[0].text


def test_latex_math_is_preserved_and_unsupported_math_is_flagged_everywhere():
    supported = '<math alttext="x^2"><msup><mi>x</mi><mn>2</mn></msup></math>'
    annotation = '<math><semantics><mfrac><mn>1</mn><mi>x</mi></mfrac><annotation encoding="application/x-tex">1/x</annotation></semantics></math>'
    unsupported = '<math><mfrac><mn>1</mn><mi>x</mi></mfrac></math>'
    rows = html_blocks('<p>Known ' + supported + annotation + ', unknown ' + unsupported + '.</p>')
    assert '\\(x^2\\)' in rows[0].text and '\\(1/x\\)' in rows[0].text
    assert '[Mathematical expression; inspect original]' in rows[0].text
    assert 'math_requires_original_inspection' in rows[0].flags
    table = html_blocks('<table><tr><td>' + unsupported + '</td></tr></table>')[0]
    assert 'math_requires_original_inspection' in table.flags
    lead, flags = article_lead('<p>' + supported + annotation + unsupported + '</p>', 1000, with_flags=True)
    assert '\\(x^2\\)' in lead and '\\(1/x\\)' in lead
    assert flags == ['math_requires_original_inspection', 'text_omitted']


def test_declared_v3_retains_legacy_bytes_and_unknown_revisions_fail_explicitly():
    legacy = 'Area: 12 m 2 . Concentration: 10 −3 mol/L. Formula: H 2 O.'
    assert html_blocks(SOURCE, 'html-structural-v3')[0].text == legacy
    assert article_lead(SOURCE, 1000, 'html-structural-v3') == legacy
    with pytest.raises(ValueError, match='revision'):
        html_blocks(SOURCE, 'invented-parser')
    with pytest.raises(ValueError, match='revision'):
        article_lead(SOURCE, 1000, 'invented-parser')


def test_v4_retains_mediawiki_heading_anchor_without_reinterpreting_v3():
    source = '<h2><span class="mw-headline" id="Area">Area m<sup>2</sup></span></h2>'
    assert html_blocks(source)[0].anchor == 'Area'
    assert html_blocks(source, 'html-structural-v3')[0].anchor is None
