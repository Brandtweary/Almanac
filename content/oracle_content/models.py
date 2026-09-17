from __future__ import annotations

import hashlib
import json
from typing import Literal
from pydantic import BaseModel, ConfigDict, Field, model_validator


def digest(value: object) -> str:
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()).hexdigest()


class Strict(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)


class Profile(Strict):
    """All retrieval operating choices are explicit, never library defaults."""
    profile_id: str
    qualified: bool = False
    receipts: list[str] = Field(default_factory=list)
    encoder_id: str
    encoder_runtime_id: str | None = None
    encoder_revision: str
    encoder_dimensions: int = Field(gt=0)
    encoder_tokenizer: str
    encoder_tokenizer_sha256: str = Field(pattern=r"^[a-f0-9]{64}$")
    encoder_max_tokens: int = Field(gt=0)
    document_prefix: str = ""
    query_prefix: str = ""
    chat_tokenizer: str
    chat_tokenizer_sha256: str = Field(pattern=r"^[a-f0-9]{64}$")
    lexical_depth: int = Field(gt=0, le=10000)
    dense_depth: int = Field(gt=0, le=10000)
    rrf_k: float = Field(gt=0)
    lexical_weight: float = Field(gt=0)
    dense_weight: float = Field(gt=0)
    page_size: int = Field(gt=0, le=1000)
    response_tokens: int = Field(gt=0)
    read_tokens: int = Field(gt=0)
    query_max_chars: int = Field(gt=0)
    request_timeout: float = Field(gt=0)
    embedding_batch: int = Field(gt=0)
    vector_datatype: Literal["float32", "float16"] = "float32"
    ranking: Literal["fusion", "reranker"] = "fusion"
    reranker_id: str | None = None
    reranker_runtime_id: str | None = None
    reranker_revision: str | None = None
    reranker_tokenizer: str | None = None
    reranker_tokenizer_sha256: str | None = None
    reranker_max_tokens: int | None = Field(default=None, gt=0)
    reranker_depth: int | None = Field(default=None, gt=0)
    reranker_batch: int | None = Field(default=None, gt=0)

    @model_validator(mode="after")
    def admission(self):
        if self.qualified and not self.receipts:
            raise ValueError("qualified profiles require evaluation receipts")
        if self.ranking == "reranker" and not all((self.reranker_id, self.reranker_revision, self.reranker_tokenizer,
                self.reranker_tokenizer_sha256, self.reranker_max_tokens, self.reranker_depth, self.reranker_batch)):
            raise ValueError("reranker profile is incomplete")
        return self

    @property
    def index_fingerprint(self):
        # Only fields changing stored vectors, segmentation or indexed text belong to the index identity.
        return digest({"schema": "structured-lexical-v2", "encoding": self.model_dump(include={"encoder_id", "encoder_revision", "encoder_dimensions",
            "encoder_tokenizer_sha256", "encoder_max_tokens", "document_prefix"})})

    @property
    def fingerprint(self):
        return digest(self.model_dump(exclude={"encoder_tokenizer", "chat_tokenizer", "reranker_tokenizer", "encoder_runtime_id", "reranker_runtime_id"}))


class Document(Strict):
    document_id: str = Field(pattern=r"^[a-zA-Z0-9_-]{1,128}$")
    work_id: str
    pack_id: str
    title: str
    edition: str = ""
    publisher: str = ""
    language: str
    source_url: str
    sha256: str = Field(pattern=r"^[a-f0-9]{64}$")
    media_type: str
    license: str
    rights_exceptions: list[str] = Field(default_factory=list)
    extraction_revision: str
    original_path: str
    article_path: str | None = None
    zim_native_index: bool = False


class Block(Strict):
    text: str
    kind: str = "paragraph"
    section: list[str] = Field(default_factory=list)
    page_index: int | None = None
    page_label: str | None = None
    coordinates: list[float] | None = None
    anchor: str | None = None
    flags: list[str] = Field(default_factory=list)


class Passage(Strict):
    passage_id: str
    document_id: str
    source_revision: str
    extraction_revision: str
    ordinal: int
    block_index: int
    start: int
    end: int
    text: str
    embedding_text: str
    section: list[str]
    kind: str
    page: dict
    flags: list[str]
    previous: str | None = None
    next: str | None = None

    @property
    def lexical_text(self):
        # Oversized structured blocks remain searchable in full even when dense encoding is only a labeled reference.
        return self.embedding_text + ("\n" + self.text if "text_omitted" in self.flags else "")


class SearchRequest(Strict):
    query: str = Field(min_length=1, max_length=65536)
    document_id: str | None = None
    cursor: str | None = Field(default=None, max_length=8192)
    require_qualified: bool = False


class ReadRequest(Strict):
    document_id: str = Field(min_length=1, max_length=128)
    passage_id: str | None = Field(default=None, max_length=256)
    cursor: str | None = Field(default=None, max_length=8192)


class ContentError(Exception):
    def __init__(self, code: str, message: str, status: int = 503):
        self.code, self.message, self.status = code, message, status
        super().__init__(message)
