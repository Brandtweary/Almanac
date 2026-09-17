"""Offline structural extraction and tokenizer-checked source spans."""
from __future__ import annotations
import hashlib
import os
from functools import lru_cache
import posixpath
import re
import zipfile
from pathlib import Path
from xml.etree import ElementTree
from bs4 import BeautifulSoup, Tag, NavigableString
from email.message import Message as MimeMessage
from .models import Block, ContentError, Document, Passage, Profile, digest


def decode_zim_html(item):
    mime = MimeMessage()
    mime["content-type"] = item.mimetype
    return bytes(item.content).decode(mime.get_content_charset() or "utf-8", errors="strict")


class TokenCounter:
    def __init__(self, path: str, sha256: str):
        from tokenizers import Tokenizer
        raw = Path(path).read_bytes()
        if hashlib.sha256(raw).hexdigest() != sha256:
            raise ValueError("tokenizer artifact digest mismatch")
        self.tokenizer = Tokenizer.from_str(raw.decode())
        self.tokenizer.no_truncation()
        self.tokenizer.no_padding()

    def count(self, text: str) -> int:
        return len(self.tokenizer.encode(text).ids)

    def pair_count(self, query: str, text: str) -> int:
        return len(self.tokenizer.encode(query, text).ids)


def inline_content(node):
    """Preserve inline mathematical structure without interpreting expressions."""
    flags = set()
    def render(value):
        if isinstance(value, NavigableString):
            return str(value)
        if not isinstance(value, Tag):
            return ""
        if value.name in {"script", "style", "nav", "noscript"}:
            return ""
        if value.name == "math":
            annotation = value.find("annotation", attrs={"encoding": re.compile(r"(?:application/x-tex|text/x-tex)", re.I)})
            tex = value.get("alttext") or (annotation.get_text() if annotation else None)
            if tex:
                return "\\(" + tex.strip() + "\\)"
            flags.add("math_requires_original_inspection")
            flags.add("text_omitted")
            return "[Mathematical expression; inspect original]"
        if value.name == "img" and any("math" in cls for cls in value.get("class", [])):
            if value.get("alt"):
                return "\\(" + value["alt"].strip() + "\\)"
            flags.add("math_requires_original_inspection")
            flags.add("text_omitted")
            return "[Mathematical expression; inspect original]"
        text = "".join(render(child) for child in value.children)
        if value.name == "sup":
            # Citation superscripts remain citations, not numerical exponents.
            if "reference" in value.get("class", []) or re.fullmatch(r"\s*\[[^\]]+\]\s*", text):
                return text
            return "^(" + text.strip() + ")"
        if value.name == "sub":
            return "_(" + text.strip() + ")"
        if value.name == "br":
            return "\n"
        return text
    return render(node), sorted(flags)


def html_blocks(html: str, revision: str = "html-structural-v4") -> list[Block]:
    if revision not in {"html-structural-v3", "html-structural-v4"}:
        raise ValueError("Unsupported HTML extraction revision; retain the original and rebuild under a supported revision")
    legacy = revision == "html-structural-v3"
    soup = BeautifulSoup(html, "html.parser")
    for node in soup(["script", "style", "nav", "noscript"]):
        node.decompose()
    blocks, headings = [], []
    heading_levels: list[int] = []
    root = soup.select_one(".mw-parser-output") or soup.find("main") or soup.find("article") or soup.body or soup
    containers = {"p", "li", "pre", "table", "figure", "ul", "ol", "div", "section", "article", "main", "blockquote"}
    headings_tags = {"h1", "h2", "h3", "h4", "h5", "h6"}

    def emit(text, kind, node, flags=None):
        text = text.strip()
        if text:
            math_flags = [] if legacy else inline_content(node)[1]
            anchor = node.get("id")
            if not legacy and kind == "heading" and not anchor:
                target = node.find(["span", "a"], id=True)
                anchor = target.get("id") if target else None
            blocks.append(Block(text=text, kind=kind, section=list(headings), anchor=anchor, flags=list(dict.fromkeys((flags or []) + math_flags))))

    def content(node):
        return node.get_text(" ", strip=True) if legacy else " ".join(inline_content(node)[0].split())

    def visit(node, inherited="paragraph"):
        nonlocal headings
        if not isinstance(node, Tag):
            return
        if not legacy and (node.name == "math" or (node.name == "img" and any("math" in cls for cls in node.get("class", [])))):
            text, flags = inline_content(node)
            emit(text, "math", node, flags)
            return
        if node.name in headings_tags:
            text = content(node)
            level = int(node.name[1])
            while heading_levels and heading_levels[-1] >= level:
                heading_levels.pop()
                headings.pop()
            heading_levels.append(level)
            headings.append(text)
            emit(text, "heading", node)
            return
        if node.name == "table":
            rows = [" | ".join(content(cell) for cell in row.find_all(["td", "th"], recursive=False))
                    for row in node.find_all("tr") if row.find_parent("table") is node]
            caption = node.find("caption", recursive=False)
            text = ((content(caption) + "\n") if caption else "") + "\n".join(rows)
            flags = []
            if node.find(attrs={"rowspan": True}) or node.find(attrs={"colspan": True}):
                flags.append("merged_cells_inspect_original")
            if not node.find("th"):
                flags.append("table_headers_unverified")
            emit(text, "table", node, flags)
            return
        if node.name == "figure":
            text = content(node)
            image = node.find("img")
            emit(text or (image.get("alt", "[Figure]") if image else "[Figure]"),
                 "figure", node, ["figure_requires_visual_inspection"])
            return
        if node.name == "img":
            emit(node.get("alt") or "[Figure]", "figure", node, ["figure_requires_visual_inspection"])
            return
        kind = "list_item" if node.name == "li" else "pre" if node.name == "pre" else inherited
        buffer = []
        def flush():
            text = " ".join(buffer) if legacy else "".join(buffer)
            if not legacy and kind != "pre":
                text = " ".join(text.split())
            emit(text, kind, node)
            buffer.clear()
        for child in node.children:
            if isinstance(child, NavigableString):
                value = str(child).strip() if legacy else str(child)
                if value:
                    buffer.append(value)
            elif isinstance(child, Tag):
                mathematical_image = child.name == "img" and any("math" in cls for cls in child.get("class", []))
                if child.name in containers or child.name in headings_tags or (child.name == "img" and (legacy or not mathematical_image)):
                    flush()
                    visit(child, kind)
                elif child.find(list(containers | headings_tags)):
                    flush()
                    visit(child, kind)
                else:
                    value = child.get_text(" ", strip=True) if legacy else inline_content(child)[0]
                    if value:
                        buffer.append(value)
        flush()

    visit(root)
    if not blocks:
        text = content(root)
        if text:
            blocks.append(Block(text=text, flags=["structure_unavailable"]))
    return blocks


def epub_blocks(path: Path, revision: str = "html-structural-v4") -> list[Block]:
    with zipfile.ZipFile(path) as archive:
        container = ElementTree.fromstring(archive.read("META-INF/container.xml"))
        rootfile = next(node.attrib["full-path"] for node in container.iter() if node.tag.endswith("rootfile"))
        package = ElementTree.fromstring(archive.read(rootfile))
        manifest = {n.attrib["id"]: n.attrib["href"] for n in package.iter() if n.tag.endswith("}item")}
        blocks = []
        for node in package.iter():
            if node.tag.endswith("}itemref"):
                name = posixpath.normpath(posixpath.join(posixpath.dirname(rootfile), manifest[node.attrib["idref"]]))
                if name.startswith("../") or name.startswith("/"):
                    raise ValueError("invalid EPUB member path")
                for block in html_blocks(archive.read(name).decode("utf-8"), revision):
                    block.anchor = name + ("#" + block.anchor if block.anchor else "")
                    blocks.append(block)
        return blocks


@lru_cache(maxsize=1)
def pdf_converter(assets_path: str, threads: int):
    """Reuse the pinned CPU parser across ingestion documents."""
    if not Path(assets_path).is_dir():
        raise ValueError("pinned offline extraction assets are required")
    from docling.document_converter import DocumentConverter, PdfFormatOption
    from docling.datamodel.base_models import InputFormat
    from docling.datamodel.pipeline_options import PdfPipelineOptions, EasyOcrOptions
    from docling.datamodel.accelerator_options import AcceleratorOptions, AcceleratorDevice
    if threads < 1:
        raise ValueError("extraction thread limit must be positive")
    options = PdfPipelineOptions(artifacts_path=Path(assets_path), enable_remote_services=False,
        accelerator_options=AcceleratorOptions(device=AcceleratorDevice.CPU, num_threads=threads))
    options.ocr_options = EasyOcrOptions(download_enabled=False, use_gpu=False, model_storage_directory=str(Path(assets_path) / "EasyOcr"))
    options.do_ocr = True
    options.do_table_structure = True
    return DocumentConverter(format_options={InputFormat.PDF: PdfFormatOption(pipeline_options=options)})


def pdf_blocks(path: Path, assets_path: str) -> list[Block]:
    """Docling supplies layout/OCR; representative inspection gates activation."""
    converter = pdf_converter(assets_path, int(os.environ["CONTENT_EXTRACTION_THREADS"]))
    result = converter.convert(path)
    if str(result.status.value) != "success":
        raise ValueError("PDF conversion incomplete: " + str(result.status.value))
    document, blocks, section = result.document, [], []
    for item, _level in document.iterate_items():
        label = str(item.label.value)
        text = getattr(item, "text", "")
        flags = []
        if label == "table":
            text = item.export_to_markdown(doc=document)
            flags.append("table_layout_requires_validation")
        if label == "picture":
            text = item.caption_text(document) or "[Figure]"
            flags.append("figure_requires_visual_inspection")
        if label == "section_header":
            section = [text]
        if not text:
            continue
        prov = item.prov[0] if item.prov else None
        blocks.append(Block(text=text, kind=label, section=list(section),
                            page_index=(prov.page_no - 1 if prov else None),
                            coordinates=([prov.bbox.l, prov.bbox.t, prov.bbox.r, prov.bbox.b] if prov else None),
                            flags=flags + ["printed_page_label_unverified"]))
    return blocks


def extract(document: Document, assets_path: str | None = None, *, verified=False, zim_archives=None) -> list[Block]:
    path = Path(document.original_path)
    if not verified:
        with path.open("rb") as stream:
            if hashlib.file_digest(stream, "sha256").hexdigest() != document.sha256:
                raise ValueError("original checksum mismatch")
    if document.media_type == "application/pdf":
        if not assets_path:
            raise ValueError("offline PDF assets are required")
        blocks = pdf_blocks(path, assets_path)
    elif document.media_type == "application/epub+zip":
        blocks = epub_blocks(path, document.extraction_revision)
    elif document.media_type == "application/x-zim":
        from libzim.reader import Archive
        if not document.article_path:
            raise ValueError("ZIM ingestion requires an article path")
        if zim_archives is None:
            archive = Archive(str(path))
        else:
            if str(path) not in zim_archives:
                zim_archives[str(path)] = Archive(str(path))
            archive = zim_archives[str(path)]
        entry = archive.get_entry_by_path(document.article_path)
        blocks = html_blocks(decode_zim_html(entry.get_item()), document.extraction_revision)
    elif document.media_type == "text/html":
        blocks = html_blocks(path.read_text(), document.extraction_revision)
    elif document.media_type == "text/plain":
        blocks = [Block(text=p.strip()) for p in re.split(r"\n\s*\n", path.read_text()) if p.strip()]
    else:
        raise ValueError("unsupported extraction media type")
    if not blocks:
        raise ValueError("empty extraction must not become an active document")
    return blocks


def segment(document: Document, blocks: list[Block], profile: Profile, tokenizer, generation: str) -> list[Passage]:
    passages = []
    for index, block in enumerate(blocks):
        prefix = profile.document_prefix + document.title + "\n" + " / ".join(block.section) + "\n"
        metadata_flags = []
        if tokenizer.count(prefix) >= profile.encoder_max_tokens:
            # Full section metadata remains on the evidence record; only the
            # encoder's redundant prefix is shortened to leave room for text.
            while prefix and tokenizer.count(prefix) >= max(2, profile.encoder_max_tokens // 2):
                prefix = prefix[:len(prefix) // 2]
            metadata_flags.append("embedding_metadata_abbreviated")
        spans = [(0, len(block.text))]
        while spans:
            start, end = spans.pop(0)
            # Inspect a bounded prefix of an oversized prose block; copying and
            # tokenizing its entire remaining tail for every span is quadratic.
            text = block.text[start:min(end, start + profile.encoder_max_tokens * 16 + 1)]
            flags = list(block.flags) + metadata_flags + (["continued_source_block"] if start else [])
            if len(text) > profile.encoder_max_tokens * 16 or tokenizer.count(prefix + text) > profile.encoder_max_tokens:
                if block.kind == "table":
                    # A table remains readable intact; a caption indexes the source rather than stripping its units.
                    text = "[Table requires original source inspection]"
                    flags += ["table_exceeds_encoder_window", "text_omitted"]
                    if tokenizer.count(prefix + text) > profile.encoder_max_tokens:
                        raise ValueError("table reference exceeds encoder window")
                else:
                    # Find a measured fitting prefix before considering structure.
                    # Tokenizing every prefix of a long block is quadratic; a
                    # whitespace-free CJK span is not one indivisible model token.
                    cut = min(len(text) - 1, max(1, profile.encoder_max_tokens * 4))
                    while tokenizer.count(prefix + text[:cut]) > profile.encoder_max_tokens:
                        if cut == 1:
                            raise ValueError("one source character exceeds encoder window")
                        cut = max(1, cut // 2)
                    for pattern in (r"(?<=[.!?])\s+|\n", r"\S+\s+"):
                        boundaries = [m.end() for m in re.finditer(pattern, text[:cut])]
                        # Token counts need not be monotone at text boundaries.
                        fitting = next((n for n in reversed(boundaries)
                            if tokenizer.count(prefix + text[:n]) <= profile.encoder_max_tokens), None)
                        if fitting:
                            cut = fitting
                            break
                    spans.insert(0, (start + cut, end))
                    end = start + cut
                    text = block.text[start:end]
                    flags += ["continued_source_block"]
            identity = digest([document.document_id, document.sha256, document.extraction_revision, index, start, end])
            passages.append(Passage(passage_id=f"p:{generation}:{identity}", document_id=document.document_id,
                source_revision=document.sha256, extraction_revision=document.extraction_revision,
                ordinal=len(passages), block_index=index, start=start, end=end, text=block.text[start:end],
                embedding_text=prefix + text, section=block.section, kind=block.kind,
                page={"index": block.page_index, "label": block.page_label, "coordinates": block.coordinates, "anchor": block.anchor}, flags=flags))
    for index, passage in enumerate(passages):
        passage.previous = passages[index - 1].passage_id if index else None
        passage.next = passages[index + 1].passage_id if index + 1 < len(passages) else None
    return passages
