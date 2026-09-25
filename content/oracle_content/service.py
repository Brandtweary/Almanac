from __future__ import annotations
import asyncio
import json
import os
import traceback
import re
import sqlite3
import time
import uuid
import weakref
from contextvars import ContextVar
from urllib.parse import quote
from .models import ContentError, Document, Profile, SearchRequest, ReadRequest, Passage, digest
from .store import HANDLE, Store, atomic_json


request_id = ContextVar("content_request_id", default=None)

def fuse(branches, weights, k):
    scores, origins = {}, {}
    for branch, rows in branches.items():
        seen = set()
        for pid, _score in rows:
            if pid in seen:
                continue
            seen.add(pid)
            rank = len(seen)
            scores[pid] = scores.get(pid, 0) + weights[branch] / (k + rank)
            origins.setdefault(pid, {})[branch] = rank
    return [{"passage_id": pid, "score": score, "ranks": origins[pid]}
            for pid, score in sorted(scores.items(), key=lambda item: (-item[1], item[0]))]


def merge_branches(pools, k):
    """Unify each retrieval branch across generations indexing disjoint corpora.

    Generations hold separate archives, so no passage appears in two pools.
    Fusing their ranks against each other therefore scores every generation's
    first hit identically, every second hit identically, and so on, and the
    order inside each of those ties falls through to the fusion tiebreak — the
    passage handle, whose leading component is the generation digest. The result
    is a ranking decided by a content hash rather than by the query, invisible
    with one or two archives installed and dominant with many. Each branch is
    unified on a relevance signal instead.

    Dense scores are directly comparable between generations. Every collection
    is created with the dimensions, datatype and Cosine distance the active
    profile pins, a search refuses a generation whose index fingerprint differs
    from that profile, and one encoder produces every vector, so cosine
    similarities out of different collections lie on a single scale and merge by
    raw value. Equal scores keep the better within-generation rank first and then
    the order the library declares its generations in.

    Lexical scores do not compare. BM25 weights a term by the statistics of the
    archive it ran over, and a native archive contributes fused article ranks
    rather than BM25 at all, so the two branches of the library do not share a
    scale or even a sign convention. Normalizing each pool over its own returned
    depth would not recover one: it maps every generation's best hit to the same
    value whatever that hit is worth, which is the same tie under another name.
    The lexical lists are fused by rank, with each generation's contribution
    weighted by where its dense evidence places it among the generations. That is
    the reciprocal-rank weighting already used to combine the disjoint article
    pools inside a native archive, and it carries a query-dependent signal into a
    dimension that otherwise has none. A generation whose dense branch returned
    nothing offers no such signal and is weighted below those that did.
    """
    affinity = []
    for pool in pools:
        scores = [score for _pid, score in pool["branches"]["dense"]]
        affinity.append(max(scores) if scores else None)
    order = sorted(range(len(pools)),
                   key=lambda i: (affinity[i] is None, -affinity[i] if affinity[i] is not None else 0.0))
    weights = {}
    for position, index in enumerate(order, 1):
        weights[str(index)] = 1 / (k + position)
    lexical = fuse({str(i): pool["branches"]["lexical"] for i, pool in enumerate(pools)}, weights, k)
    dense = []
    for index, pool in enumerate(pools):
        for rank, (pid, score) in enumerate(pool["branches"]["dense"], 1):
            dense.append((-score, rank, index, pid, score))
    dense.sort(key=lambda row: row[:3])
    return {"lexical": [(row["passage_id"], row["score"]) for row in lexical],
            "dense": [(pid, score) for _negated, _rank, _index, pid, score in dense]}


def remove_contained(rows, passages):
    kept = []
    for row in rows:
        p = passages[row["passage_id"]]
        contained = False
        for other in rows:
            q = passages[other["passage_id"]]
            if q.passage_id == p.passage_id:
                continue
            same = (p.document_id, p.source_revision, p.extraction_revision, p.block_index) == (
                q.document_id, q.source_revision, q.extraction_revision, q.block_index)
            if same and q.start <= p.start and q.end >= p.end and (
                (q.start, q.end) != (p.start, p.end) or q.passage_id < p.passage_id):
                if p.text == q.text[p.start - q.start:p.end - q.start]:
                    contained = True
                    break
        if not contained:
            kept.append(row)
    return kept


# A snapshot is read only by resume(), which serves a continuation cursor the
# client follows while its search is still on screen. Citations do not depend on
# one: evidence is a content-addressed passage handle resolved through
# Store.passage(), so an expired snapshot costs a repeated search and nothing
# else. Retention is therefore a storage policy, not part of retrieval identity,
# and is deliberately absent from the profile fingerprint.
SNAPSHOT_TTL_SECONDS = 900
SNAPSHOT_MAX_BYTES = 256 * 1024 * 1024
SNAPSHOT_PRUNE_INTERVAL_SECONDS = 30

# Failure records are reachable by ordinary request traffic, so the diagnostic
# store carries a fixed disk allotment rather than growing with the fault rate.
# The live file and one retained predecessor together stay inside it: rotating
# into a single file would let a burst erase every older record before anyone
# read it, and the predecessor keeps that evidence for one full cycle.
FAILURE_LOG_MAX_BYTES = 64 * 1024 * 1024
# A repeating identical fault is written at occurrences 1, 2, 4, 8, ... with its
# own occurrence ordinal, so one recurring stack reports its rate without
# crowding every other failure out of the allotment. The map is per process and
# bounded, because it is a write filter rather than an accounting ledger.
FAILURE_FINGERPRINTS_MAX = 512

# Lexical retrieval over a native archive localizes each article hit by decoding,
# block-parsing and segmenting the whole article, which is Python-bound work that
# shares one interpreter. Run concurrently, searches interleave instead of
# queueing: measured on the served library, three simultaneous first-time
# searches each returned in about the time all three needed together, so none
# finished early and all three passed the caller's deadline, while the same three
# run one after another returned in a third of that. Admission keeps the
# aggregate work identical and hands it out in arrival order, so the first
# request is answered at a single search's cost rather than the batch's.
LEXICAL_CONCURRENCY = 1

# An archive that cannot serve this request at all, rather than a stage that failed:
# its original's receipt changed (a mend is between writing and recording it) or
# integrity withdrew it. It costs that archive's hits, named in the degradation.
ARCHIVE_LOSS = frozenset({"unavailable_version", "source_damaged"})

# A listing names the works a staged pack carries. Past this many the remainder is counted
# instead, so a pack acquired as thousands of separate documents stays a readable entry.
COLLECTION_WORKS_LIMIT = 64


class Service:
    lexical_concurrency = LEXICAL_CONCURRENCY

    def __init__(self, store: Store, profile: Profile, dense, tokenizer, zim=None, reranker=None, *,
                 snapshot_ttl=SNAPSHOT_TTL_SECONDS, snapshot_max_bytes=SNAPSHOT_MAX_BYTES,
                 failure_log_max_bytes=FAILURE_LOG_MAX_BYTES,
                 lexical_concurrency=LEXICAL_CONCURRENCY):
        self.store, self.profile, self.dense, self.tokenizer = store, profile, dense, tokenizer
        self.zim, self.reranker = zim, reranker
        self.snapshot_ttl, self.snapshot_max_bytes = snapshot_ttl, snapshot_max_bytes
        self.snapshot_pruned_at, self.snapshot_bytes_written = None, 0
        self.failure_log_max_bytes, self.failure_counts = failure_log_max_bytes, {}
        self.lexical_concurrency = max(1, lexical_concurrency)

    def rotate_failures(self, pending):
        """Keep the failure store and its one predecessor inside the allotment."""
        path = self.store.root / "failures.jsonl"
        # Each of the two files is held under half the allotment, so their sum
        # never exceeds it. A record larger than half rotates on every write and
        # the store degrades to the two most recent records rather than growing.
        half = max(self.failure_log_max_bytes // 2, 1)
        try:
            size = path.stat().st_size
        except FileNotFoundError:
            return
        if size + pending > half:
            os.replace(path, path.with_name("failures.1.jsonl"))

    def record_failure(self, stage, generation, error):
        # Traceback frames retain mechanism evidence without serializing query-bearing exception text.
        frames = traceback.format_tb(error.__traceback__)
        fingerprint = digest([stage, generation, type(error).__name__, frames])[:16]
        if len(self.failure_counts) >= FAILURE_FINGERPRINTS_MAX:
            self.failure_counts.clear()
        count = self.failure_counts[fingerprint] = self.failure_counts.get(fingerprint, 0) + 1
        if count & (count - 1):
            return  # Between powers of two the ordinal on the next record carries the rate.
        record = {"request_id": request_id.get(), "stage": stage, "generation": generation, "type": type(error).__name__,
                  "fingerprint": fingerprint, "count": count, "traceback": frames}
        line = (json.dumps(record) + "\n").encode()
        try:
            self.rotate_failures(len(line))
            fd = os.open(self.store.root / "failures.jsonl", os.O_APPEND | os.O_CREAT | os.O_WRONLY, 0o600)
            try:
                os.write(fd, line)
            finally:
                os.close(fd)
        except OSError:
            pass  # Failure reporting cannot replace the original retrieval failure.

    def pack_label(self, generation):
        manifest = self.store.manifest(generation)
        source = manifest.get("source") or {}
        return source.get("pack_id") or ",".join(sorted(manifest.get("packs", []))) or generation[:12]

    def withdrawn(self, generation):
        """The integrity overlay's verdict that a whole archive is out of service, or None."""
        manifest = self.store.manifest(generation)
        if manifest.get("kind") != "native-zim-article-v1":
            return None
        view = self.store.integrity.archive(manifest["source"]["sha256"])
        return view.withdrawn_reason if view is not None and view.withdrawn else None

    def health(self):
        """Readiness of the library, where one archive's failure costs that archive alone.

        An archive that cannot be opened or verified, or that integrity has withdrawn,
        is excluded from the checks and named in `unavailable_archives` and in
        `degradation`; the library stays ready while any archive serves. Qualification
        is judged over the archives still serving. The gateway refuses every chat
        completion while the library is not ready, so a single damaged header would
        otherwise take the whole service down.
        """
        try:
            generation = self.store.active()
            generations = self.store.active_generations()
        except (ContentError, sqlite3.Error):
            return {"ready": False, "generation": None, "profile_id": self.profile.profile_id, "qualified": False,
                    "coverage": self.store.coverage(None), "degradation": [], "unavailable_archives": []}
        ready, dense_complete, serving, unavailable = True, True, [], []
        for source_generation in generations:
            manifest = self.store.manifest(source_generation)
            ready = ready and manifest["index_fingerprint"] == self.profile.index_fingerprint
            try:
                if self.withdrawn(source_generation) is not None:
                    raise ContentError("source_damaged", "Archive withdrawn for integrity damage")
                native = self.store.native(source_generation)
                if native is not None:
                    native.verify_original()
                    indexed = native.archive.has_fulltext_index
                else:
                    with self.store.connect(source_generation) as db:
                        indexed = db.execute("SELECT 1 FROM passages LIMIT 1").fetchone() is not None
            except (ContentError, sqlite3.Error, OSError, RuntimeError) as error:
                code = getattr(error, "code", type(error).__name__)
                pack = self.pack_label(source_generation)
                unavailable.append({"generation": source_generation, "pack_id": pack, "code": code})
                continue
            ready = ready and indexed
            if native is not None:
                dense_complete = dense_complete and manifest.get("dense_stage") == "complete"
            serving.append(source_generation)
        degradation = [f"integrity:{row['pack_id']}:withdrawn" if row["code"] == "source_damaged"
                       else f"archive_unavailable:{row['pack_id']}" for row in unavailable]
        return {"ready": ready and bool(serving), "generation": generation, "profile_id": self.profile.profile_id,
                "qualified": self.profile.qualified and dense_complete and bool(serving),
                "coverage": self.store.coverage(generation), "degradation": degradation,
                "unavailable_archives": unavailable}

    def collections(self):
        """List the installed library itself: what it holds, rather than what a query found.

        A native archive is one collection, named by the title it was prepared under. A staged
        generation holds separately acquired works, so it contributes one collection per pack,
        naming the works it carries up to `COLLECTION_WORKS_LIMIT` and counting the remainder.
        Both read the recorded manifest and catalog; neither opens an archive, because a listing
        is answered far more often than it changes.
        """
        from .native import KIND as NATIVE_KIND
        entries = []
        for generation in self.store.active_generations():
            manifest = self.store.manifest(generation)
            category = manifest.get("category", "")
            if manifest.get("kind") == NATIVE_KIND:
                doc = Document.model_validate(manifest["source"])
                # The archive's own HTML-entry count stands for what a search can
                # reach only while every entry is admitted. Under a selection policy
                # the indexed count is the reachable one, and `indexing_complete`
                # says whether it is final or still climbing.
                articles = manifest.get("indexed_articles") if manifest["selection_policy"] != "canonical-html" \
                    else (manifest.get("canonical_html_articles") or manifest.get("indexed_articles"))
                entries.append({"category": category, "title": doc.title, "publisher": doc.publisher,
                                "origin": doc.source_url, "language": doc.language, "articles": articles,
                                "works": [], "additional_works": 0,
                                "indexing_complete": manifest.get("dense_stage") == "complete",
                                "packs": sorted(manifest.get("packs", []))})
                continue
            packs = {}
            with self.store.connect(generation) as db:
                for row in db.execute("SELECT data FROM documents ORDER BY rowid"):
                    doc = Document.model_validate_json(row[0])
                    pack = packs.setdefault(doc.pack_id, {"category": category, "title": doc.pack_id,
                        "publisher": doc.publisher, "origin": doc.source_url, "language": doc.language,
                        "articles": None, "works": [], "additional_works": 0,
                        "indexing_complete": True, "packs": [doc.pack_id]})
                    if pack["publisher"] != doc.publisher:
                        pack["publisher"] = ""
                    if len(pack["works"]) < COLLECTION_WORKS_LIMIT:
                        pack["works"].append(doc.title)
                    else:
                        pack["additional_works"] += 1
            entries.extend(packs[pack_id] for pack_id in sorted(packs))
        return {**self.base(self.store.active()), "collections": entries}

    def base(self, generation, degradation=None):
        degradation = degradation or []
        return {"generation": generation, "profile_id": self.profile.profile_id,
                "status": "degraded" if degradation else "ok" if self.profile.qualified else "unqualified",
                "degradation": degradation, "coverage": self.store.coverage(generation)}

    def active(self):
        generation = self.store.active()
        if self.store.manifest(generation)["index_fingerprint"] != self.profile.index_fingerprint:
            raise ContentError("profile_mismatch", "Active corpus uses a different release profile")
        return generation

    def fit_dense_query(self, query):
        """Fit a query to the sentence encoder's window, reporting whether it was cut.

        The accepted query length is several times the encoder window, so a query
        that overflows it is ordinary input rather than a fault: the dense branch
        answers on the leading portion that fits and the result set carries
        `dense_query_truncated`, which keeps a narrower dense contribution visible
        instead of presenting it as full coverage. The lexical branch always sees
        the whole query, and indexing never truncates — a shortened passage would
        misrepresent what the corpus holds.

        Returns the query to encode and whether anything was removed. The search
        is over character prefixes because token counts are not additive: the
        prefix and query tokenize together.
        """
        prefixed, window = self.profile.query_prefix + query, self.profile.encoder_max_tokens
        if self.tokenizer.count(prefixed) <= window:
            return query, False
        low, high = 0, len(query)
        while high - low > 1:
            middle = (low + high) // 2
            if self.tokenizer.count(self.profile.query_prefix + query[:middle]) <= window:
                low = middle
            else:
                high = middle
        return query[:low], True

    def lexical_gate(self):
        # One semaphore per loop, created on first use: the running service has
        # a single loop, while a test drives an instance from a fresh one.
        if "lexical_gates" not in self.__dict__:
            self.lexical_gates = weakref.WeakKeyDictionary()
        loop = asyncio.get_running_loop()
        gate = self.lexical_gates.get(loop)
        if gate is None:
            gate = self.lexical_gates[loop] = asyncio.Semaphore(self.lexical_concurrency)
        return gate

    async def lexical(self, generation, query, document_id):
        # Localization runs in a thread, and cancelling the coroutine awaiting a
        # thread does not stop the thread. Releasing the gate when this
        # coroutine is cancelled — at the request deadline, or when a visitor
        # closes the tab mid-search — would admit the next search alongside an
        # orphan that still holds the interpreter and the reader's locks, which
        # is exactly the interleaving the gate exists to prevent. So the gate is
        # released by the work's own completion rather than by whoever waits on
        # it, and a cancelled caller returns immediately while its orphan keeps
        # its place in the queue.
        gate = self.lexical_gate()
        await gate.acquire()
        work = asyncio.ensure_future(self._lexical(generation, query, document_id))

        def completed(finished):
            gate.release()
            if not finished.cancelled():
                # Retrieve it so an abandoned orphan's failure is not reported
                # as an unhandled exception when it is garbage collected; the
                # caller that is still waiting receives it through the shield.
                finished.exception()

        work.add_done_callback(completed)
        return await asyncio.shield(work)

    async def _lexical(self, generation, query, document_id):
        native = self.store.native(generation)
        if native is not None:
            if self.zim is None:
                raise ValueError("native ZIM lexical adapter unavailable")
            return await native.lexical(self.zim, query, self.profile.lexical_depth, document_id)
        rows = self.store.lexical(generation, query, self.profile.lexical_depth, document_id)
        with self.store.connect(generation) as db:
            sql = "SELECT DISTINCT original_path FROM documents WHERE native=1"
            params = ()
            if document_id:
                sql += " AND id=?"
                params = (document_id,)
            paths = [r[0] for r in db.execute(sql, params)]
        if paths and self.zim is None:
            raise ValueError("native ZIM lexical adapter unavailable")
        branches = {"extracted": rows}
        # Native libzim queries are conjunctive, without Boolean operators.
        safe_query = " ".join(re.findall(r"[^\W_]+", query))
        for index, path in enumerate(paths):
            hits = await self.zim.search(str(self.store.root / path), safe_query, self.profile.lexical_depth, title_query=query)
            native = await asyncio.to_thread(self._localize_native_hits, generation, path, hits, query, document_id)
            branches[f"zim{index}"] = [(r["passage_id"], r["score"]) for r in native[:self.profile.lexical_depth]]
        if len(branches) == 1:
            return rows
        return [(row["passage_id"], row["score"]) for row in fuse(branches, {k: 1 for k in branches}, self.profile.rrf_k)][:self.profile.lexical_depth]

    def _localize_native_hits(self, generation, path, hits, query, document_id):
        """Rank passages inside each native article hit, off the event loop.

        Opening catalog connections, building a fresh in-memory FTS5 table per
        article and running BM25 over it is pure CPU and disk work costing tens
        to hundreds of milliseconds, and the service has one event loop: run
        inline in a coroutine it stalls every other in-flight request for its
        duration, since a coroutine yields only at an await. `native.py` keeps
        the same work in `_localize` for the same reason. The catalog connection
        is opened here rather than handed in because a sqlite3 connection
        belongs to the thread that created it.
        """
        article_branches, article_weights = {}, {}
        with self.store.connect(generation) as db:
            for article_rank, article in enumerate(hits, 1):
                scope = " AND id=?" if document_id else ""
                args = (path, article, document_id) if document_id else (path, article)
                found = db.execute("SELECT id FROM documents WHERE original_path=? AND article_path=?" + scope, args).fetchone()
                if not found:
                    continue
                # Localize within each native article hit, never rebuild the whole archive's lexical index.
                local = sqlite3.connect(":memory:")
                try:
                    local.execute("CREATE VIRTUAL TABLE article USING fts5(id UNINDEXED,text,tokenize='porter unicode61')")
                    for row in db.execute("SELECT id,data FROM passages WHERE document_id=? ORDER BY ordinal", (found[0],)):
                        passage = Passage.model_validate_json(row[1])
                        local.execute("INSERT INTO article VALUES(?,?)", (row[0], passage.lexical_text))
                    lexical_query = " OR ".join('"' + token.replace('"', '""') + '"'
                        for token in re.findall(r"[^\W_]+(?:[-./][^\W_]+)*", query, re.UNICODE))
                    localized = local.execute("SELECT id,bm25(article) FROM article WHERE article MATCH ? ORDER BY bm25(article),id LIMIT ?",
                                              (lexical_query, self.profile.lexical_depth)).fetchall() if lexical_query else []
                finally:
                    local.close()
                if not localized:
                    # Native title/redirect/stem matches still locate an article even without literal passage terms.
                    localized = [(r[0], 0) for r in db.execute(
                        "SELECT id FROM passages WHERE document_id=? ORDER BY ordinal LIMIT ?",
                        (found[0], self.profile.lexical_depth))]
                if localized:
                    article_branches[article] = localized
                    article_weights[article] = 1 / (self.profile.rrf_k + article_rank)
        return fuse(article_branches, article_weights, self.profile.rrf_k)

    async def candidates(self, query, document_id=None, generation=None):
        """Evaluation seam: independent ranks and fused pool before reranking/packing.

        Integrity damage costs what it touches and no more. An archive the overlay
        withdraws is left out and named; one whose original became unavailable mid-search
        is dropped from this result and named; a withdrawn lexical index or failed dense
        validation removes that branch for that archive alone; and hits on quarantined
        documents are dropped. Each of these is a `degradation` code, so a result missing
        pieces never reads as a complete one.
        """
        if generation is None:
            generations, degradation = [], []
            for value in self.store.active_generations():
                if self.withdrawn(value) is None:
                    generations.append(value)
                else:
                    degradation.append(f"integrity:{self.pack_label(value)}:withdrawn")
            if not generations:
                raise ContentError("source_damaged", "Every archive in the library is withdrawn for integrity damage")
            if document_id:
                scoped = []
                for candidate in generations:
                    try:
                        self.store.document(candidate, document_id)
                        scoped.append(candidate)
                    except ContentError as error:
                        if error.code not in {"unknown_document", "source_excluded"}:
                            raise
                if not scoped:
                    raise ContentError("unknown_document", "Document is outside the active library", 404)
                generations = scoped
            if len(generations) == 1:
                pool = await self.candidates(query, document_id, generations[0])
                pool["degradation"] = [*pool["degradation"], *degradation]
                return pool
            results = await asyncio.gather(*(self.candidates(query, document_id, value) for value in generations),
                                           return_exceptions=True)
            pools, lost = [], None
            for value, result in zip(generations, results):
                if isinstance(result, ContentError) and result.code in ARCHIVE_LOSS:
                    degradation.append(self.loss_label(value, result))
                    lost = lost or result
                    continue
                if isinstance(result, BaseException):
                    raise result
                pools.append(result)
            if not pools:
                raise lost
            branches = merge_branches(pools, self.profile.rrf_k)
            rows = fuse(branches, {"lexical": self.profile.lexical_weight, "dense": self.profile.dense_weight}, self.profile.rrf_k)
            passages = {key: value for pool in pools for key, value in pool["passages"].items()}
            return {"generation": pools[0]["generation"], "generations": [pool["generation"] for pool in pools],
                    "branches": branches, "rows": remove_contained(rows, passages), "passages": passages,
                    "degradation": sorted({*degradation, *(value for pool in pools for value in pool["degradation"])})}
        generation = generation or self.active()
        manifest = self.store.manifest(generation)
        if manifest["index_fingerprint"] != self.profile.index_fingerprint:
            raise ContentError("profile_mismatch", "Active corpus uses a different release profile")
        if document_id:
            self.store.document(generation, document_id)
        pack = self.pack_label(generation)
        view = (self.store.integrity.archive(manifest["source"]["sha256"])
                if manifest.get("kind") == "native-zim-article-v1" else None)
        lexical_withdrawn = view is not None and view.lexical_withdrawn
        dense_withdrawn = self.store.integrity.dense_degraded(generation)

        async def withheld():
            return []

        dense_query, dense_truncated = self.fit_dense_query(query)
        lexical, dense = await asyncio.gather(
            withheld() if lexical_withdrawn else self.lexical(generation, query, document_id),
            withheld() if dense_withdrawn else self.dense.search(generation, dense_query, document_id),
            return_exceptions=True)
        if isinstance(lexical, BaseException):
            if isinstance(lexical, asyncio.CancelledError):
                raise lexical
            if isinstance(lexical, ContentError) and lexical.code in ARCHIVE_LOSS:
                raise lexical
            self.record_failure("lexical", generation, lexical)
            raise ContentError("lexical_unavailable", "Lexical retrieval failed; search was not completed") from lexical
        degradation = []
        if lexical_withdrawn:
            degradation.append(f"integrity:{pack}:lexical")
        if dense_withdrawn:
            degradation.append(f"integrity:{pack}:dense")
        if dense_truncated:
            degradation.append("dense_query_truncated")
        if manifest.get("kind") == "native-zim-article-v1" and manifest.get("dense_stage") != "complete":
            degradation.append("dense_index_incomplete")
        if isinstance(dense, BaseException):
            if isinstance(dense, asyncio.CancelledError):
                raise dense
            self.record_failure("dense", generation, dense)
            dense = []
            degradation.append("dense_unavailable")
        rows = fuse({"lexical": lexical, "dense": dense},
                    {"lexical": self.profile.lexical_weight, "dense": self.profile.dense_weight}, self.profile.rrf_k)
        known = getattr(lexical, "passages", {})
        # Resolving a dense-only hit decodes and parses its source article. On a
        # native archive that is tens to hundreds of milliseconds per hit and the
        # service runs one event loop, so it never happens on the loop itself.
        def resolve():
            found = []
            for row in rows:
                try:
                    found.append(known.get(row["passage_id"]) or self.store.passage(generation, row["passage_id"]))
                except ContentError as error:
                    if error.code != "source_damaged":
                        raise
                    found.append(None)
            return found
        passages, dropped = {}, getattr(lexical, "damaged", 0)
        for p in await asyncio.to_thread(resolve):
            if p is None:
                dropped += 1
                continue
            if document_id and p.document_id != document_id:
                raise ContentError("index_scope_mismatch", "Candidate escaped its document scope")
            passages[p.passage_id] = p
        if dropped:
            degradation.append(f"integrity:{pack}")
            rows = [row for row in rows if row["passage_id"] in passages]
            # Union ranking consumes the branches again, so refused handles must
            # leave both branch pools as well as the already-fused rows.
            lexical = [(pid, score) for pid, score in lexical if pid in passages]
            dense = [(pid, score) for pid, score in dense if pid in passages]
        return {"generation": generation, "branches": {"lexical": lexical, "dense": dense},
                "rows": remove_contained(rows, passages), "passages": passages, "degradation": degradation}

    def loss_label(self, generation, error):
        pack = self.pack_label(generation)
        return f"integrity:{pack}:withdrawn" if error.code == "source_damaged" else f"archive_unavailable:{pack}"

    def collection(self, generation, doc):
        """The work a document sits inside, for display alongside a title that alone says little.

        A native archive contributes the pack title declared when it was prepared, the
        same label for every article it holds; a staged document contributes its own
        publisher. The catalog records no finer grouping, so a document whose series
        lives only in its body text carries no series here.
        """
        native = self.store.native(generation)
        label = native.template.title if native is not None else doc.publisher
        return label if label and label.casefold() != doc.title.casefold() else ""

    def hit(self, generation, passage, omit=False):
        generation = HANDLE.fullmatch(passage.passage_id)[1]
        doc = self.store.document(generation, passage.document_id)
        return {"passage_id": passage.passage_id, "document_id": doc.document_id,
                "source_revision": passage.source_revision, "extraction_revision": passage.extraction_revision,
                "title": doc.title, "collection": self.collection(generation, doc),
                "edition": doc.edition, "section": passage.section, "page": passage.page,
                "excerpt": "" if omit else passage.text,
                "complete": not omit and not any(f in passage.flags for f in ("continued_source_block", "text_omitted")),
                "source": {"url": "/v1/corpus/source/" + quote(passage.passage_id, safe=""),
                           "sha256": doc.sha256, "media_type": doc.media_type, "origin": doc.source_url,
                           "representation": "article_text" if doc.media_type == "application/x-zim" else "original"},
                "previous": passage.previous, "next": passage.next, "kind": passage.kind,
                "flags": passage.flags + (["text_omitted_budget"] if omit else [])}

    def prune_snapshots(self, force=False):
        """Expire continuations an unauthenticated visitor can mint without limit."""
        now = time.monotonic()
        # Scanning the directory on every write is wasted work at request rates,
        # so the interval carries ordinary traffic and the byte counter bounds
        # how far a burst can overshoot the ceiling between two scans.
        if (not force and self.snapshot_pruned_at is not None
                and now - self.snapshot_pruned_at < SNAPSHOT_PRUNE_INTERVAL_SECONDS
                and self.snapshot_bytes_written * 4 < self.snapshot_max_bytes):
            return
        self.snapshot_pruned_at, self.snapshot_bytes_written = now, 0
        directory = self.store.root / "snapshots"
        deadline = time.time() - self.snapshot_ttl
        live = []
        for path in directory.glob("*.json*"):
            try:
                stat = path.stat()
            except OSError:
                continue  # Another worker expired it first.
            if stat.st_mtime < deadline:
                path.unlink(missing_ok=True)
                continue
            # A recent ".tmp" belongs to an atomic write still in flight; an old
            # one was expired above as the residue of an interrupted write.
            if path.suffix != ".tmp":
                live.append((stat.st_mtime, stat.st_size, path))
        total = sum(size for _mtime, size, _path in live)
        # The newest is never evicted: a ceiling below one result set would
        # otherwise kill a continuation before its own response was returned.
        for _mtime, size, path in sorted(live)[:-1]:
            if total <= self.snapshot_max_bytes:
                break
            path.unlink(missing_ok=True)
            total -= size

    def snapshot_versions(self, generations):
        """Bind cached text and ranks to the integrity state that produced them."""
        versions = {}
        for generation in generations:
            manifest = self.store.manifest(generation)
            if manifest.get("kind") != "native-zim-article-v1":
                continue
            integrity = self.store.integrity
            artifact = manifest["source"]["sha256"]
            spans_epoch = integrity.epoch("spans-" + generation)
            view = integrity.archive(artifact)
            versions[generation] = [integrity.epoch(artifact), spans_epoch,
                                    integrity.spans_usable(generation, spans_epoch),
                                    integrity.dense_degraded(generation),
                                    view.lexical_withdrawn if view is not None else False]
        return versions

    def save_snapshot(self, data, binding, versions):
        generations = data.get("generations", [data["generation"]])
        current = self.snapshot_versions(generations)
        if current != {generation: versions.get(generation) for generation in current}:
            raise ContentError("invalid_cursor", "Corpus integrity changed during retrieval; repeat the request", 400)
        self.prune_snapshots()
        key = uuid.uuid4().hex
        path = self.store.root / "snapshots" / (key + ".json")
        atomic_json(path, {"binding": binding, "data": data, "integrity_versions": current})
        self.snapshot_bytes_written += path.stat().st_size
        return key

    def cursor(self, key, offset):
        # Opaque random snapshot IDs are server-issued capabilities; the offset grants no extra scope.
        return f"{key}:{offset}"

    def resume(self, cursor, binding):
        if not re.fullmatch(r"[a-f0-9]{32}:[0-9]{1,9}", cursor):
            raise ContentError("invalid_cursor", "Malformed continuation cursor", 400)
        key, offset = cursor.split(":")
        try:
            snapshot = json.loads((self.store.root / "snapshots" / (key + ".json")).read_text())
        except FileNotFoundError:
            raise ContentError("invalid_cursor", "Continuation is unavailable; repeat the search", 400) from None
        if snapshot["binding"] != binding:
            raise ContentError("invalid_cursor", "Continuation does not belong to this request", 400)
        data = snapshot["data"]
        generations = data.get("generations", [data["generation"]])
        versions = self.snapshot_versions(generations)
        if snapshot.get("integrity_versions", {}) != versions:
            raise ContentError("invalid_cursor", "Corpus integrity changed; repeat the request", 400)
        readers = {}
        for generation in generations:
            native = self.store.native(generation)
            if native is not None:
                native.verify_original()
                readers[generation] = native
        documents = {(HANDLE.fullmatch(row["passage_id"])[1], row["document_id"])
                     for row in data.get("hits", data.get("passages", []))}
        if "document" in data:
            documents.add((data["generation"], data["document"]["document_id"]))
        degradation = list(data["degradation"])
        for generation, document_id in documents:
            native = readers.get(generation)
            if native is None:
                continue
            native.document(document_id)
            if "document" in data:
                from .integrity.overlay import NOT_ADMITTED, VERIFIED
                label = f"integrity:{self.pack_label(generation)}:read_unverified"
                degradation = [value for value in degradation if value != label]
                if native.verify_read(int(document_id.rsplit("_", 1)[1])) not in (VERIFIED, NOT_ADMITTED):
                    degradation.append(label)
        # A repair concurrent with validation also retires this cached response.
        if self.snapshot_versions(generations) != versions:
            raise ContentError("invalid_cursor", "Corpus integrity changed; repeat the request", 400)
        data = {**data, **self.base(data["generation"], degradation)}
        return key, int(offset), data

    def result_set(self, hits):
        """Describe the whole ranked set, so a page is not read as the whole library.

        A response carries the leading few hits of a set that can run to hundreds
        across several collections, and nothing else in the envelope separates
        "this is the best the library holds" from "this is the first page of many,
        and the collection that answers the question starts further down".
        `degradation` does not: it names retrieval stages that failed or were
        clipped, and a set whose good answers are simply off the page had no stage
        fail. `cursor` says only that something follows.

        `total` counts the ranked hits behind the page and `offset` locates the
        page inside them. Each collection reports how many of those hits are its
        own and the best rank it reached, which is what tells a caller holding
        three rows whether a further page is worth asking for. A collection is
        named the way its hits are, and falls back to the document title where a
        hit carries no separate collection name.
        """
        collections = {}
        for rank, hit in enumerate(hits, 1):
            generation = HANDLE.fullmatch(hit["passage_id"])[1]
            entry = collections.get(generation)
            if entry is None:
                collections[generation] = {"collection": hit["collection"] or hit["title"],
                                           "hits": 1, "best_rank": rank}
            else:
                entry["hits"] += 1
        return {"total": len(hits), "offset": 0, "collections": list(collections.values())}

    def page(self, snapshot, key, offset, field, budget):
        rows = snapshot[field]
        if offset > len(rows):
            raise ContentError("invalid_cursor", "Continuation offset exceeds result set", 400)
        result = {k: v for k, v in snapshot.items() if k != field}
        if "result_set" in result:
            result["result_set"] = {**result["result_set"], "offset": offset}
        selected = []
        end = min(len(rows), offset + self.profile.page_size)
        for row in rows[offset:end]:
            trial = {**result, field: selected + [row], "cursor": self.cursor(key, end) if end < len(rows) else None}
            if self.tokenizer.count(json.dumps(trial, ensure_ascii=False)) > budget:
                if selected:
                    end = offset + len(selected)
                    break
                row = {**row, "excerpt": "", "complete": False, "flags": row.get("flags", []) + ["text_omitted_budget"]}
                trial = {**result, field: [row], "cursor": self.cursor(key, offset + 1) if offset + 1 < len(rows) else None}
                if self.tokenizer.count(json.dumps(trial, ensure_ascii=False)) > budget:
                    raise ContentError("profile_budget_invalid", "Evidence metadata exceeds configured token budget")
                selected.append(row)
                end = offset + 1
                break
            selected.append(row)
        return {**result, field: selected, "cursor": self.cursor(key, end) if end < len(rows) else None}

    async def search(self, request: SearchRequest):
        query = request.query.strip()
        if not query or len(query) > self.profile.query_max_chars:
            raise ContentError("invalid_request", "Query is empty or exceeds the configured limit", 400)
        if request.require_qualified and not self.profile.qualified:
            raise ContentError("profile_unqualified", "No qualified retrieval profile is installed")
        binding = digest(["search", query, request.document_id, request.require_qualified, self.profile.fingerprint])
        if request.cursor:
            key, offset, snapshot = await asyncio.to_thread(self.resume, request.cursor, binding)
        else:
            versions = self.snapshot_versions(self.store.active_generations())
            pool = await self.candidates(query, request.document_id)
            generation, rows, degradation = pool["generation"], pool["rows"], pool["degradation"]
            if self.profile.ranking == "reranker":
                candidates = rows[:self.profile.reranker_depth]
                # A query paired with a near-limit passage can exceed the
                # cross-encoder's pair window, which is ordinary long input and
                # not an outage: `rank` refuses the whole batch for one such
                # pair, so the overflowing candidates are set aside here and
                # keep their fusion rank. Recording this as a service fault
                # would fill the bounded diagnostic store with non-faults and
                # fail a require_qualified request over a long question.
                scorable = [r for r in candidates
                            if self.tokenizer.pair_count(query, pool["passages"][r["passage_id"]].embedding_text)
                            <= self.profile.reranker_max_tokens]
                if len(scorable) != len(candidates):
                    degradation.append("reranker_window_exceeded")
                try:
                    if self.reranker is None:
                        raise ValueError("reranker unavailable")
                    if scorable:
                        scores = await self.reranker.rank(query, [pool["passages"][r["passage_id"]] for r in scorable])
                        omitted = [r for r in candidates if r["passage_id"] not in scores]
                        rows = sorted(scorable, key=lambda row: (-scores[row["passage_id"]], -row["score"], row["passage_id"])) + omitted
                except Exception as exc:
                    self.record_failure("reranker", generation, exc)
                    degradation.append("reranker_unavailable")
            if degradation and request.require_qualified:
                raise ContentError("qualified_profile_unavailable", "Required retrieval stages failed")
            hits = [self.hit(generation, pool["passages"][row["passage_id"]]) for row in rows]
            snapshot = {**self.base(generation, degradation), "generations": pool.get("generations", [generation]),
                "result_set": self.result_set(hits), "hits": hits}
            key, offset = self.save_snapshot(snapshot, binding, versions), 0
        return self.page(snapshot, key, offset, "hits", self.profile.response_tokens)

    async def read(self, request: ReadRequest):
        binding = digest(["read", request.document_id, request.passage_id, self.profile.fingerprint])
        if request.cursor:
            key, offset, snapshot = await asyncio.to_thread(self.resume, request.cursor, binding)
        else:
            # Reading an uncached native article decodes and segments the whole
            # article synchronously; on the service's single event loop that
            # would block every other visitor and the disconnect watcher with it.
            snapshot, key, offset = await asyncio.to_thread(self.read_snapshot, request, binding)
        return self.page(snapshot, key, offset, "passages", self.profile.read_tokens)

    def read_snapshot(self, request: ReadRequest, binding):
        if request.passage_id:
            match = HANDLE.fullmatch(request.passage_id)
            if not match:
                raise ContentError("invalid_handle", "Malformed passage handle", 400)
            generation = match[1]
            versions = self.snapshot_versions([generation])
            selected = self.store.passage(generation, request.passage_id)
            if selected.document_id != request.document_id:
                raise ContentError("invalid_handle", "Passage belongs to another document", 400)
        else:
            generation = None
            for candidate in self.store.active_generations():
                try:
                    self.store.document(candidate, request.document_id)
                    generation = candidate
                    break
                except ContentError as error:
                    if error.code not in {"unknown_document", "source_excluded"}:
                        raise
            if generation is None:
                raise ContentError("unknown_document", "Document is outside the active library", 404)
            versions = self.snapshot_versions([generation])
            selected = None
        doc = self.store.document(generation, request.document_id)
        native = self.store.native(generation)
        degradation = []
        if native is not None:
            # A person is about to read this text: its bytes are re-hashed first, and a
            # read of an admitted archive the re-hash could not check says so.
            from .integrity.overlay import NOT_ADMITTED, VERIFIED
            if native.verify_read(int(doc.document_id.rsplit("_", 1)[1])) not in (VERIFIED, NOT_ADMITTED):
                degradation.append(f"integrity:{self.pack_label(generation)}:read_unverified")
        passages = list(self.store.passages(generation, doc.document_id))
        if selected:
            # Direct expansion starts one source neighbor earlier and can continue to the end.
            passages = [selected, *passages] if selected.kind == "article_lead" else passages[max(0, selected.ordinal - 1):]
        hits = [self.hit(generation, p, omit=selected is None) for p in passages]
        snapshot = {**self.base(generation, degradation), "document": {"document_id": doc.document_id, "title": doc.title,
            "collection": self.collection(generation, doc),
            "edition": doc.edition, "publisher": doc.publisher, "language": doc.language,
            "source_revision": doc.sha256, "license": doc.license, "rights_exceptions": doc.rights_exceptions},
            "overview": selected is None, "passages": hits}
        return snapshot, self.save_snapshot(snapshot, binding, versions), 0
