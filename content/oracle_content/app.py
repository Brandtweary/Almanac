"""Internal ASGI service. Request IDs/stages are logged without queries or memory."""
from __future__ import annotations
import asyncio
from contextlib import asynccontextmanager
import json
import mimetypes
import logging
import os
from pathlib import Path
import re
import time
import unicodedata
import urllib.parse
import uuid
import httpx
from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, JSONResponse, Response
from .adapters import Embeddings, Qdrant, Reranker, ZimLexical
from .extract import TokenCounter, html_blocks, decode_zim_html
from .models import ContentError, Profile, SearchRequest, ReadRequest
from .service import (Service, FAILURE_LOG_MAX_BYTES, LEXICAL_CONCURRENCY, SNAPSHOT_MAX_BYTES,
                      SNAPSHOT_TTL_SECONDS, request_id)
from .store import HANDLE, Store
from .phonemize import NativePhonemizer, PhonemizeRequest, PhonemizeBodyLimit

LOG = logging.getLogger("oracle_content")
LOG.setLevel(logging.INFO)
if not LOG.handlers:
    LOG.addHandler(logging.StreamHandler())
LOG.propagate = False

# Media types a browser renders directly. Every source response carries the route's
# sandbox policy and `nosniff`, so an inline document is displayed in an opaque origin
# with scripting and subresource loading denied. Anything outside this set is saved.
INLINE_MEDIA_TYPES = frozenset({"text/plain", "text/html", "application/pdf",
                                "image/jpeg", "image/png", "image/gif", "image/webp"})


def source_filename(doc, media_type):
    """The document's own title reduced to a filename, with the served type's extension.

    A content-addressed handle is an identity, not a name: without this the browser
    falls back to the request path and saves the handle itself, untyped.
    """
    # Apostrophes close up rather than splitting a word; everything else unsafe separates.
    spaced = re.sub(r"[^\w.\- ]", " ", re.sub(r"['‘’ʼ`]", "", doc.title))
    stem = re.sub(r"\s+", " ", spaced).strip(" .-")[:96].strip(" .-")
    return (stem or doc.document_id) + (mimetypes.guess_extension(media_type) or "")


def disposition(media_type, filename):
    """Display a renderable source; save anything else under a typed, readable name.

    `filename*` carries the real name. The plain `filename` is the ASCII fallback an
    older client reads, so it keeps the extension even when the title transliterates
    away entirely.
    """
    kind = "inline" if media_type in INLINE_MEDIA_TYPES else "attachment"
    stem, dot, extension = filename.rpartition(".")
    if not dot:
        stem, extension = filename, ""
    folded = unicodedata.normalize("NFKD", stem).encode("ascii", "ignore").decode()
    fallback = (re.sub(r"[^A-Za-z0-9._\- ]", "", folded).strip(" .-") or "source") + dot + extension
    return f"{kind}; filename=\"{fallback}\"; filename*=UTF-8''{urllib.parse.quote(filename, safe='')}"


def configured_service(client):
    root = Path(os.environ["CONTENT_STATE_DIR"]).resolve()
    profile_path = Path(os.environ["CONTENT_PROFILE"]).resolve()
    profile = Profile.model_validate_json(profile_path.read_text())
    def artifact(name):
        path = Path(name)
        return str(path if path.is_absolute() else profile_path.parent / path)
    encoder = TokenCounter(artifact(profile.encoder_tokenizer), profile.encoder_tokenizer_sha256)
    chat = TokenCounter(artifact(profile.chat_tokenizer), profile.chat_tokenizer_sha256)
    embeddings = Embeddings(client, os.environ["CONTENT_EMBED_URL"], profile, encoder)
    dense = Qdrant(client, os.environ["CONTENT_QDRANT_URL"], embeddings, profile)
    reranker = None
    if profile.ranking == "reranker":
        reranker = Reranker(client, os.environ["CONTENT_RERANK_URL"], profile,
            TokenCounter(artifact(profile.reranker_tokenizer), profile.reranker_tokenizer_sha256))
    return Service(Store(root), profile, dense, chat, ZimLexical(), reranker,
        snapshot_ttl=float(os.environ.get("CONTENT_SNAPSHOT_TTL_SECONDS", SNAPSHOT_TTL_SECONDS)),
        snapshot_max_bytes=int(os.environ.get("CONTENT_SNAPSHOT_MAX_BYTES", SNAPSHOT_MAX_BYTES)),
        failure_log_max_bytes=int(os.environ.get("CONTENT_FAILURE_LOG_MAX_BYTES", FAILURE_LOG_MAX_BYTES)),
        lexical_concurrency=int(os.environ.get("CONTENT_LEXICAL_CONCURRENCY", LEXICAL_CONCURRENCY)))


def create_app(service=None, phonemizer=None):
    @asynccontextmanager
    async def lifespan(app):
        await app.state.phonemizer.initialize()
        if service is not None:
            app.state.service = service
            yield
        else:
            async with httpx.AsyncClient(timeout=30, trust_env=False) as client:
                app.state.service = configured_service(client)
                client.timeout = httpx.Timeout(app.state.service.profile.request_timeout)
                yield

    app = FastAPI(title="Offline reference content", lifespan=lifespan)
    app.state.phonemizer = phonemizer if phonemizer is not None else NativePhonemizer.configured()
    app.add_middleware(PhonemizeBodyLimit)
    if service is not None:
        app.state.service = service

    @app.middleware("http")
    async def observation(request: Request, call_next):
        request.state.request_id = uuid.uuid4().hex
        request_id.set(request.state.request_id)
        started = time.monotonic()
        response = await call_next(request)
        LOG.info(json.dumps({"request_id": request.state.request_id, "method": request.method,
            "status": response.status_code, "duration_ms": round((time.monotonic() - started) * 1000)}))
        response.headers["X-Request-ID"] = request.state.request_id
        return response

    @app.exception_handler(ContentError)
    async def content_error(request, error):
        return JSONResponse(status_code=error.status, content={"error": {"code": error.code, "message": error.message},
            "request_id": request.state.request_id})

    @app.exception_handler(RequestValidationError)
    async def validation_error(request, error):
        return JSONResponse(status_code=400, content={"error": {"code": "invalid_request", "message": "Request does not match the tool schema"},
            "request_id": request.state.request_id})

    @app.get("/health")
    @app.get("/capabilities")
    async def health(request: Request):
        return {**request.app.state.service.health(), "phonemizer": request.app.state.phonemizer.capability()}

    async def cancellable(request, operation):
        task = asyncio.create_task(asyncio.wait_for(operation, timeout=request.app.state.service.profile.request_timeout))
        async def disconnected():
            # Polling is_disconnected() wraps its receive in a cancelled scope and can swallow watcher cancellation.
            while True:
                message = await request.receive()
                if message["type"] == "http.disconnect":
                    return
        watcher = asyncio.create_task(disconnected())
        try:
            done, _ = await asyncio.wait({task, watcher}, return_when=asyncio.FIRST_COMPLETED)
            if watcher in done and task not in done:
                task.cancel()
                raise ContentError("cancelled", "Request was disconnected", 499)
            try:
                return await task
            except asyncio.TimeoutError:
                raise ContentError("request_timeout", "Operation exceeded its configured deadline", 504) from None
        finally:
            watcher.cancel()
            if not task.done():
                task.cancel()
            await asyncio.gather(task, watcher, return_exceptions=True)

    @app.post("/v1/corpus/search")
    async def search(body: SearchRequest, request: Request):
        return await cancellable(request, request.app.state.service.search(body))

    @app.post("/v1/corpus/read")
    async def read(body: ReadRequest, request: Request):
        return await cancellable(request, request.app.state.service.read(body))

    @app.post("/v1/phonemize")
    async def phonemize(body: PhonemizeRequest, request: Request):
        return await cancellable(request, request.app.state.phonemizer.convert(body))

    @app.get("/v1/corpus/source/{handle}")
    async def source(handle: str, request: Request):
        # Rendering a native article decodes and block-parses the whole article;
        # it shares the event loop with every other request and its own
        # disconnect watcher, so it runs in a thread under the same deadline.
        return await cancellable(request, asyncio.to_thread(render_source, request.app.state.service, handle))

    def render_source(service, handle: str):
        match = HANDLE.fullmatch(handle)
        if not match:
            raise ContentError("invalid_handle", "Malformed source handle", 400)
        store = service.store
        passage = store.passage(match[1], handle)
        doc = store.document(match[1], passage.document_id)
        path = store.root / doc.original_path
        if not path.is_file():
            raise ContentError("unavailable_version", "Original source bytes are unavailable", 410)
        receipt_path = path.with_suffix(".receipt.json")
        receipt = json.loads(receipt_path.read_text()) if receipt_path.exists() else {}
        stat = path.stat()
        if (receipt.get("sha256") != doc.sha256 or receipt.get("size") != stat.st_size or
                receipt.get("mtime_ns") != stat.st_mtime_ns):
            raise ContentError("unavailable_version", "Original source integrity receipt changed; reverify the installation", 410)
        headers = {"Content-Security-Policy": "sandbox; default-src 'none'", "X-Content-Type-Options": "nosniff"}
        if doc.media_type == "application/x-zim":
            if doc.extraction_revision not in {"html-structural-v3", "html-structural-v4"}:
                raise ContentError("unsupported_extraction_revision", "Text rendering for this retained archive is unavailable; original bytes remain installed", 409)
            from libzim.reader import Archive
            entry = Archive(str(path)).get_entry_by_path(doc.article_path)
            text = "\n\n".join(block.text for block in html_blocks(decode_zim_html(entry.get_item()), doc.extraction_revision))
            attribution = f"{doc.title}\nSource: {doc.source_url}\nLicense: {doc.license}\n"
            if doc.edition:
                attribution += f"Edition: {doc.edition}\n"
            if doc.publisher:
                attribution += f"Attribution: {doc.publisher}\n"
            return Response(attribution + "\n" + text, media_type="text/plain",
                headers={**headers, "Content-Disposition": disposition("text/plain", source_filename(doc, "text/plain"))})
        name = source_filename(doc, doc.media_type)
        return FileResponse(path, media_type=doc.media_type, headers={**headers, "Content-Disposition": disposition(doc.media_type, name)})

    return app


app = create_app()
