"""Internal ASGI service. Request IDs/stages are logged without queries or memory."""
from __future__ import annotations
import asyncio
from contextlib import asynccontextmanager
import json
import mimetypes
import logging
import os
from pathlib import Path
import time
import uuid
import httpx
from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, JSONResponse, Response
from .adapters import Embeddings, Qdrant, Reranker, ZimLexical
from .extract import TokenCounter, html_blocks, decode_zim_html
from .models import ContentError, Profile, SearchRequest, ReadRequest
from .service import Service, request_id
from .store import HANDLE, Store
from .phonemize import NativePhonemizer, PhonemizeRequest, PhonemizeBodyLimit

LOG = logging.getLogger("oracle_content")
LOG.setLevel(logging.INFO)
if not LOG.handlers:
    LOG.addHandler(logging.StreamHandler())
LOG.propagate = False


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
    return Service(Store(root), profile, dense, chat, ZimLexical(), reranker)


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
        match = HANDLE.fullmatch(handle)
        if not match:
            raise ContentError("invalid_handle", "Malformed source handle", 400)
        store = request.app.state.service.store
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
            return Response(attribution + "\n" + text, media_type="text/plain", headers=headers)
        return FileResponse(path, media_type=doc.media_type, filename=doc.document_id + (mimetypes.guess_extension(doc.media_type) or ""), headers=headers)

    return app


app = create_app()
