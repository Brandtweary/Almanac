"""Deterministic measurements of the production extraction/index representation."""
from __future__ import annotations

import json
import math
import random
import sqlite3
import tempfile
import time
from pathlib import Path

from .extract import extract, segment
from .models import Document, Profile, digest
from .store import build_catalog


def sample_indices(population: int, count: int, seed: int) -> list[int]:
    if population < 1 or count < 1:
        raise ValueError("Population and sample size must be positive")
    return sorted(random.Random(seed).sample(range(population), min(population, count)))


def projection(values: list[int | float], population: int) -> dict:
    """Normal-approximation sampling error is diagnostic, not a capacity guarantee."""
    n = len(values)
    if not n or n > population:
        raise ValueError("Invalid sample population")
    mean = sum(values) / n
    variance = sum((value - mean) ** 2 for value in values) / (n - 1) if n > 1 else 0
    error = 1.96 * math.sqrt(variance / n * ((population - n) / (population - 1) if population > 1 else 0))
    return {"sample_total": sum(values), "sample_mean": mean, "estimate": mean * population,
            "approximate_95_percent_interval": [max(0, mean - error) * population, (mean + error) * population],
            "sample_max": max(values), "census": n == population,
            "caveat": "Heavy-tailed article sizes can invalidate a normal interval; reserve headroom and monitor actual growth."}


def measure_documents(documents: list[Document | None], profile: Profile, tokenizer, population: int,
                      scratch: Path, *, embedding_sample_limit: int = 96):
    """Measure real SQLite bytes and serialized receipts without embedding or activation.

    None observations represent redirects/non-HTML entries in the sampled production
    manifest population. The original archive is read in place and is never copied.
    """
    scratch.mkdir(parents=True, exist_ok=True)
    metrics = {key: [] for key in ("documents", "passages", "html_bytes", "extracted_receipt_bytes",
                                   "passage_json_bytes", "manifest_json_bytes", "extract_segment_seconds")}
    sampled_documents, sampled_passages, embedding_inputs, errors = [], [], [], []
    archives = {}
    generation = digest(["capacity-sample", profile.index_fingerprint])
    for document in documents:
        row = dict.fromkeys(metrics, 0)
        if document is not None:
            started = time.perf_counter()
            try:
                blocks = extract(document, verified=True, zim_archives=archives)
                passages = segment(document, blocks, profile, tokenizer, generation)
                row.update(documents=1, passages=len(passages),
                           extracted_receipt_bytes=len(json.dumps([block.model_dump() for block in blocks], ensure_ascii=False).encode()),
                           passage_json_bytes=sum(len(p.model_dump_json().encode()) for p in passages),
                           manifest_json_bytes=len(document.model_dump_json().encode()))
                if document.media_type == "application/x-zim":
                    row["html_bytes"] = len(archives[document.original_path].get_entry_by_path(document.article_path).get_item().content)
                else:
                    row["html_bytes"] = Path(document.original_path).stat().st_size
                sampled_documents.append(document)
                sampled_passages.extend(passages)
                # Spread measurement texts across articles instead of using only the first large article.
                if passages and len(embedding_inputs) < embedding_sample_limit:
                    embedding_inputs.append(passages[len(passages) // 2].embedding_text)
            except Exception as error:
                errors.append({"document_id": document.document_id, "article_path": document.article_path,
                               "error": type(error).__name__, "message": str(error)})
            row["extract_segment_seconds"] = time.perf_counter() - started
        for key in metrics:
            metrics[key].append(row[key])
    with tempfile.TemporaryDirectory(prefix="corpus-capacity-", dir=scratch) as temporary:
        database = Path(temporary) / "catalog.sqlite"
        build_catalog(database, sampled_documents, sampled_passages)
        catalog_bytes = database.stat().st_size
        with sqlite3.connect(database) as connection:
            page_size = connection.execute("PRAGMA page_size").fetchone()[0]
            lexical_rows = connection.execute("SELECT count(*) FROM fts").fetchone()[0]
    estimates = {key: projection(values, population) for key, values in metrics.items()}
    passages = estimates["passages"]["estimate"]
    # Production retains both its shared extraction cache and generation extraction receipts.
    text_receipts = 2 * estimates["extracted_receipt_bytes"]["estimate"]
    vector_bytes = passages * profile.encoder_dimensions * 4
    catalog_estimate = catalog_bytes * population / len(documents)
    return {"population": population, "sample_size": len(documents), "failed_samples": errors,
            "estimable": not errors, "profile_id": profile.profile_id,
            "index_fingerprint": profile.index_fingerprint, "metrics": estimates,
            "storage": {"sample_catalog_bytes": catalog_bytes, "sqlite_page_size": page_size,
                        "sample_extracted_lexical_rows": lexical_rows,
                        "catalog_bytes_extrapolated": catalog_estimate,
                        "two_extraction_receipts_json_bytes_extrapolated": text_receipts,
                        "dense_float32_vector_bytes_extrapolated": vector_bytes,
                        "represented_bytes_extrapolated": catalog_estimate + text_receipts + vector_bytes,
                        "excluded": ["Qdrant payloads, HNSW, WAL and optimizer temporary space",
                                     "SQLite extraction/manifests indexes, page overhead and temporary journals",
                                     "original archive, retained old generations and portable bundle copies"]}}, embedding_inputs


def zim_sample(template: Document, count: int, seed: int):
    """Match the canonical HTML enumeration used by ingest.zim_documents."""
    from libzim.reader import Archive
    archive = Archive(template.original_path)
    indices = sample_indices(archive.entry_count, count, seed)
    documents = []
    for index in indices:
        entry = archive._get_entry_by_id(index)
        if entry.is_redirect:
            documents.append(None)
            continue
        item = entry.get_item()
        if item.mimetype not in {"text/html", "application/xhtml+xml"}:
            documents.append(None)
            continue
        documents.append(template.model_copy(update={"document_id": digest([template.work_id, entry.path]),
            "title": entry.title, "article_path": entry.path, "zim_native_index": archive.has_fulltext_index}))
    return documents, {"entry_count": archive.entry_count, "article_count": archive.article_count,
                       "all_entry_count": archive.all_entry_count, "archive_uuid": str(archive.uuid),
                       "archive_bytes": archive.filesize, "native_fulltext": archive.has_fulltext_index,
                       "seed": seed, "sample_indices": indices}
