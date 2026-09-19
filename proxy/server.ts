import { pinnedCompletionBody, vllmTokenizePayload } from "./tokenize";
import { speechBridge } from "./speech-socket";
import { Hono, type MiddlewareHandler } from "hono";
import { cors } from "hono/cors";
import { bodyLimit } from "hono/body-limit";
import { appendFileSync, readFileSync, realpathSync } from "node:fs";
import { resolve, sep } from "node:path";
import { config, validateProfile, type GatewayConfig, type ReleaseProfile } from "./config";
import { AdmissionError, CompletionQueue } from "./queue";
import { VoiceBroker, registerVoiceRoutes } from "./voice-broker";
import { clientIp, createLimiters, WINDOW_MS, type RouteName } from "./rate-limit";
import { Subscribers } from "./subscribers";

export function createGateway(cfg: GatewayConfig = config, fetcher: typeof fetch = fetch, providedProfile?: ReleaseProfile) {
  if (cfg.qualificationMode && cfg.qualificationBoundary && cfg.qualificationBoundary !== "isolated-container") throw new Error("invalid qualification boundary declaration");
  // The installer validates host publication and network isolation before supplying this declaration.
  if (cfg.qualificationMode && !["127.0.0.1", "::1", "localhost"].includes(cfg.host) && cfg.qualificationBoundary !== "isolated-container") throw new Error("qualification mode requires loopback binding or an installer-validated isolated-container boundary");
  let profile: ReleaseProfile | null = null;
  let profileError = "release_profile_missing";
  const log = (event: object) => { try { appendFileSync(cfg.logPath, JSON.stringify({at: new Date().toISOString(), ...event}) + "\n"); } catch (error) { console.error("gateway log write failed", error); } };
  try { if (providedProfile) profile = validateProfile(providedProfile, cfg.qualificationMode); else if (cfg.profilePath) profile = validateProfile(JSON.parse(readFileSync(cfg.profilePath, "utf8")), cfg.qualificationMode); }
  catch (error) { profileError = "release_profile_invalid"; log({stage: "profile", status: "failed", error: String(error)}); }
  const app = new Hono();
  app.use("*", async (c, next) => { await next(); const policy = c.res.headers.get("Content-Security-Policy"); c.header("Content-Security-Policy", `${policy ? policy + "; " : ""}frame-ancestors 'none'`); });
  const queue = profile ? new CompletionQueue(profile.limits, log) : null;
  // Every route below is reachable without authentication; the window is the
  // only thing standing between one visitor and a shared local backend.
  const limiters = createLimiters();
  const limit = (route: RouteName): MiddlewareHandler => async (c, next) => {
    if (!limiters[route].limited(clientIp(c, cfg.trustedProxies))) return next();
    log({stage: "rate_limit", status: "rejected", route});
    return c.json({error: {code: "rate_limited"}}, 429, {"Retry-After": String(Math.ceil(WINDOW_MS / 1000))});
  };
  app.use("*", cors({origin: cfg.allowedOrigins, allowMethods: ["GET", "POST", "DELETE", "OPTIONS"], exposeHeaders: ["X-Request-Id"]}));
  app.use("*", bodyLimit({maxSize: Math.max(131072, profile?.limits.maxRequestBytes ?? 65536, profile?.limits.speechMaxBytes ?? 65536), onError: c => c.json({error: {code: "body_too_large"}}, 413)}));
  app.onError((error, c) => { log({stage: "request", status: "failed", error: error.name}); return c.json({error: {code: "gateway_failure"}}, 500); });
  async function corpus(signal?: AbortSignal) {
    try {
      const r = await fetcher(`${cfg.contentBase}/capabilities`, {signal: AbortSignal.any([signal ?? new AbortController().signal, AbortSignal.timeout(5000)])});
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json();
      if (!data || typeof data.ready !== "boolean") throw new Error("invalid capability response");
      return data;
    } catch (error) { log({stage: "corpus_health", status: "failed", error: error instanceof Error ? error.name : "unknown"}); return {ready: false, error: "corpus_unavailable"}; }
  }
  async function readiness(signal?: AbortSignal) {
    const content = await corpus(signal);
    let modelReady = false;
    if (profile && cfg.llmBase) {
      try { const r = await fetcher(`${cfg.llmBase}/health`, {signal: AbortSignal.timeout(5000)}); modelReady = r.ok; }
      catch { modelReady = false; }
    }
    return {ready: !!profile?.qualified && modelReady && content.ready === true && content.qualified === true, qualificationMode: cfg.qualificationMode, status: !profile ? profileError : !modelReady ? "model_unavailable" : !content.ready ? "corpus_unavailable" : !content.qualified && !cfg.qualificationMode ? "corpus_unqualified" : !profile.qualified ? "qualification_only" : "ready", profile,
      capabilities: {corpus: content.ready === true, personalMemory: true, speech: {stt: !!cfg.sttBase, tts: !!cfg.ttsBase}, webSearch: !!cfg.searxngBase}, corpus: content};
  }
  app.get("/health", c => c.json({ok: true, state: "running", last_progress_ts: Date.now() / 1000}));
  app.get("/v1/profile", async c => c.json(await readiness(c.req.raw.signal)));
  app.get("/ready", async c => { const r = await readiness(c.req.raw.signal); return c.json(r, r.ready ? 200 : 503); });
  app.get("/v1/requests/:id", c => { const status = queue?.status(c.req.param("id")); return status ? c.json(status) : c.json({error: {code: "request_unknown"}}, 404); });
  app.delete("/v1/requests/:id", c => queue?.cancel(c.req.param("id")) ? c.json({state: "interrupted"}) : c.json({error: {code: "request_unknown"}}, 404));
  for (const tool of ["search", "read"]) app.post(`/v1/corpus/${tool}`, limit("corpus"), async c => {
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body !== "object" || Array.isArray(body)) return c.json({error: {code: "invalid_request"}}, 400);
    try {
      const upstream = await fetcher(`${cfg.contentBase}/v1/corpus/${tool}`, {method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify(body), signal: AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(30000)])});
      const data = await upstream.json(); return c.json(data, upstream.status as 200);
    } catch (error) { log({stage: `corpus_${tool}`, status: "failed", error: error instanceof Error ? error.name : "unknown"}); return c.json({error: {code: "corpus_unavailable"}}, 502); }
  });
  app.post("/v1/phonemize", limit("phonemize"), async c => {
    const body = await c.req.text();
    if (new TextEncoder().encode(body).length > 131072) return c.json({error: {code: "body_too_large"}}, 413);
    try {
      const upstream = await fetcher(`${cfg.contentBase}/v1/phonemize`, {
        method: "POST", headers: {"Content-Type": "application/json"}, body,
        signal: AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(15000)]),
      });
      return c.json(await upstream.json(), upstream.status as 200);
    } catch {
      log({stage: "phonemize", status: "failed"});
      return c.json({error: {code: "phonemizer_unavailable"}}, 502);
    }
  });
  async function countTokens(body: Record<string, unknown>, signal: AbortSignal) {
    if (profile?.model.parser === "vllm") {
      const result = await fetcher(`${cfg.llmBase}/tokenize`, {method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify(vllmTokenizePayload(body, profile.model.excludeToolsWhenNone)), signal});
      const tokens = await result.json();
      if (!result.ok || !Array.isArray(tokens.tokens) || tokens.tokens.some((x: unknown) => !Number.isSafeInteger(x) || Number(x) < 0) || tokens.count !== tokens.tokens.length || !Number.isSafeInteger(tokens.max_model_len) || tokens.max_model_len < profile.model.contextWindow) throw new AdmissionError("tokenizer_failed", 502);
      return tokens.count;
    }
    if (!profile || profile.model.parser !== "llama.cpp") throw new AdmissionError("tokenizer_adapter_unavailable");
    const template = await fetcher(`${cfg.llmBase}/apply-template`, {method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify(body), signal});
    const formatted = await template.json();
    if (!template.ok || typeof formatted.prompt !== "string") throw new AdmissionError("template_failed", 502);
    const result = await fetcher(`${cfg.llmBase}/tokenize`, {method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify({content: formatted.prompt, add_special: true, parse_special: true}), signal});
    const tokens = await result.json();
    if (!result.ok || !Array.isArray(tokens.tokens) || tokens.tokens.some((x: unknown) => !Number.isSafeInteger(x))) throw new AdmissionError("tokenizer_failed", 502);
    return tokens.tokens.length;
  }
  app.post("/v1/tokenize", limit("tokenize"), async c => {
    if (!profile || !cfg.llmBase) return c.json({error: {code: "runtime_unconfigured"}}, 503);
    const raw = await c.req.json().catch(() => null);
    if (!raw || typeof raw !== "object" || Array.isArray(raw) || !Array.isArray(raw.messages) || raw.model !== profile.model.id) return c.json({error: {code: "invalid_request"}}, 400);
    // Counting must measure the same render the backend will perform, so the
    // same filter applies here as on the completion route.
    const body = pinnedCompletionBody(raw);
    try { return c.json({tokens: await countTokens(body, AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(15000)]))}); }
    catch (error) { log({stage: "tokenize", status: "failed", error: error instanceof Error ? error.name : "unknown"}); return c.json({error: {code: error instanceof AdmissionError ? error.code : "tokenizer_failed"}}, 502); }
  });
  app.post("/v1/chat/completions", limit("completions"), async c => {
    if (!profile || !queue || !cfg.llmBase) return c.json({error: {code: "runtime_unconfigured"}}, 503);
    const raw = await c.req.text();
    if (new TextEncoder().encode(raw).length > profile.limits.maxRequestBytes) return c.json({error: {code: "body_too_large"}}, 413);
    let parsed: Record<string, unknown>; try { parsed = JSON.parse(raw); } catch { return c.json({error: {code: "invalid_json"}}, 400); }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return c.json({error: {code: "invalid_completion"}}, 400);
    // Client fields outside the application's own payload never reach the backend.
    const body = pinnedCompletionBody(parsed);
    const id = c.req.header("X-Request-Id") ?? crypto.randomUUID();
    const conversation = c.req.header("X-Conversation-Id") ?? id;
    const priority = c.req.header("X-Request-Priority") ?? "foreground";
    if (!/^[A-Za-z0-9_-]{16,128}$/.test(id) || !/^[A-Za-z0-9_-]{1,128}$/.test(conversation) || !["foreground", "background"].includes(priority)) return c.json({error: {code: "invalid_routing_handle"}}, 400);
    if (!body || body.model !== profile.model.id || !Array.isArray(body.messages) || !body.messages.length || (body.stream !== undefined && typeof body.stream !== "boolean")) return c.json({error: {code: "invalid_completion"}}, 400);
    const role = c.req.header("X-Request-Role") ?? (priority === "foreground" ? "chat" : "memory");
    const budgets = profile.roles[role];
    if (!budgets) return c.json({error: {code: "invalid_role"}}, 400);
    const max = body.max_tokens ?? body.max_completion_tokens ?? budgets.maxOutputTokens;
    if (!Number.isSafeInteger(max) || Number(max) < 1 || Number(max) > budgets.maxOutputTokens) return c.json({error: {code: "output_budget_exceeded"}}, 400);
    delete body.max_completion_tokens; body.max_tokens = max;
    Object.assign(body, profile.model.sampling ?? {});
    const content = await corpus(c.req.raw.signal);
    if (!content.ready || (!content.qualified && !cfg.qualificationMode)) return c.json({error: {code: "corpus_unavailable"}}, 503);
    let lease;
    try {
      lease = await queue.acquire(id, conversation, priority as "foreground" | "background", c.req.raw.signal);
      const tokens = await countTokens(body, lease.signal);
      if (tokens > budgets.maxInputTokens || tokens + Number(max) > profile.model.contextWindow) throw new AdmissionError("context_budget_exceeded", 413);
      const upstream = await fetcher(`${cfg.llmBase}/v1/chat/completions`, {method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify(body), signal: lease.signal});
      if (!upstream.ok || !upstream.body) { await upstream.body?.cancel(); throw new AdmissionError("inference_failed", 502); }
      if (!body.stream) {
        const data = await upstream.json();
        if (!Array.isArray(data.choices) || !data.choices.length || data.choices.some((x: any) => !x.message || !["stop", "tool_calls", "length"].includes(x.finish_reason))) throw new AdmissionError("invalid_completion_response", 502);
        lease.finish(); return c.json(data);
      }
      const reader = upstream.body.getReader(); const owned = lease;
      const decoder = new TextDecoder(); let tail = "", complete = false;
      let streamController: ReadableStreamDefaultController<Uint8Array>;
      const onAbort = () => {
        void reader.cancel(owned.signal.reason).finally(() => owned.finish("failed"));
        try { streamController.error(owned.signal.reason); } catch { /* Stream is already closed. */ }
      };
      const stream = new ReadableStream<Uint8Array>({
        start(controller) { streamController = controller; owned.signal.addEventListener("abort", onAbort, {once: true}); if (owned.signal.aborted) onAbort(); },
        async pull(controller) {
          try {
            const chunk = await reader.read();
            if (chunk.done) {
              owned.signal.removeEventListener("abort", onAbort);
              if (!complete) throw new AdmissionError("incomplete_generation", 502);
              owned.finish(); controller.close();
            } else {
              const text = tail + decoder.decode(chunk.value, {stream: true});
              complete ||= /(?:^|\n)data: ?\[DONE\](?:\r?\n|$)/.test(text);
              tail = text.slice(-64); controller.enqueue(chunk.value);
            }
          } catch (error) { owned.signal.removeEventListener("abort", onAbort); owned.finish("failed"); controller.error(error); }
        },
        async cancel(reason) { queue.cancel(id); try { await reader.cancel(reason); } finally { owned.signal.removeEventListener("abort", onAbort); owned.finish("failed"); } },
      });
      return new Response(stream, {headers: {"Content-Type": "text/event-stream", "Cache-Control": "no-store", "X-Request-Id": id}});
    } catch (error) {
      lease?.finish("failed"); const err = error instanceof AdmissionError ? error : new AdmissionError("inference_failed", 502);
      log({id, stage: "completion", status: "failed", code: err.code});
      return c.json({error: {code: err.code, message: err.code}, request_id: id}, err.status as 503);
    }
  });
  // An address left on the About page. The shape check bounds what is stored and
  // rejects obvious nonsense; deliverability is not established here and no mail
  // is ever sent from this process. The store is opened when the gateway starts,
  // so a path that cannot be written reports itself before a visitor's address
  // depends on it.
  const SIGNUP_MAX_CHARS = 254;
  const SIGNUP_ADDRESS = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  let subscribers: Subscribers | null = null;
  try { subscribers = new Subscribers(cfg.subscriberDb); }
  catch (error) { log({stage: "signup_store", status: "failed", error: error instanceof Error ? error.name : "unknown"}); }
  app.post("/v1/signup", limit("signup"), async c => {
    if (!subscribers) return c.json({error: {code: "signup_unavailable"}}, 503);
    const body = await c.req.json().catch(() => null);
    const email = body && typeof body === "object" && typeof (body as {email?: unknown}).email === "string"
      ? (body as {email: string}).email.trim().toLowerCase() : "";
    if (!email || email.length > SIGNUP_MAX_CHARS || !SIGNUP_ADDRESS.test(email)) return c.json({error: {code: "invalid_request"}}, 400);
    try { subscribers.add(email, clientIp(c, cfg.trustedProxies)); }
    catch (error) { log({stage: "signup", status: "failed", error: error instanceof Error ? error.name : "unknown"}); return c.json({error: {code: "signup_unavailable"}}, 503); }
    return c.json({ok: true});
  });
  app.get("/v1/web-search", limit("webSearch"), async c => {
    const q = c.req.query("q")?.trim();
    if (!q || q.length > 4096) return c.json({error: {code: "invalid_query"}}, 400);
    try {
      const r = await fetcher(`${cfg.searxngBase}/search?q=${encodeURIComponent(q)}&format=json`, {signal: AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(15000)])});
      const data = await r.json();
      if (!r.ok || !Array.isArray(data.results) || data.results.some((x: any) => !x || typeof x.url !== "string")) throw new Error("invalid search response");
      const degraded = Array.isArray(data.unresponsive_engines) && data.unresponsive_engines.length > 0;
      if (degraded && !data.results.length) throw new Error("all search engines failed");
      return c.json({results: data.results.slice(0, 10).map((r: any) => ({title: r.title || "Untitled", url: r.url, snippet: r.content || r.abstract || ""})), degraded});
    } catch (error) { log({stage: "web_search", status: "failed", error: error instanceof Error ? error.name : "unknown"}); return c.json({error: {code: "web_search_unavailable"}}, 502); }
  });
  const EMBED_MAX_INPUTS = 64, EMBED_MAX_INPUT_CHARS = 8192;
async function embeddingIdentity(signal: AbortSignal): Promise<string> {
	const response = await fetcher(`${cfg.embedBase}/info`, { signal });
	if (!response.ok) throw new Error(`embedding metadata HTTP ${response.status}`);
	const info = await response.json();
	if (!info || typeof info.model_id !== "string" || !info.model_id ||
		typeof info.model_sha !== "string" || !/^[a-f0-9]{40}$/i.test(info.model_sha)) {
		throw new Error("embedding backend must pin --revision to an immutable model commit");
	}
	return JSON.stringify({ model_id: info.model_id, model_sha: info.model_sha,
		model_type: info.model_type, max_input_length: info.max_input_length,
		version: info.version, serving_sha: info.sha, model_dtype: info.model_dtype, normalize: true });
}

// Open (per-client rate-limited) embedding passthrough. Proxies text to the local
// embedding-inference service and returns the vectors — the browser cannot reach
// that service directly, and CORS forbids a cross-origin call. Input contract is
// {inputs: string[]}; output adds encoder lineage to the validated vectors as
// {encoder, embeddings}. Used by the personal-memory pipeline's mint-time dedup
// (one call per term write). The same encoder backs corpus dense retrieval, so
// the window here protects retrieval for every visitor.
app.post("/v1/embed", limit("embed"), async (c) => {
	let body: { inputs?: unknown };
	try {
		body = (await c.req.json()) as { inputs?: unknown };
	} catch {
		return c.json({ error: "invalid JSON body" }, 400);
	}
	if (!body || !Array.isArray(body.inputs) || body.inputs.some((s) => typeof s !== "string")) {
		return c.json({ error: "inputs must be a string array" }, 400);
	}
	const inputs = body.inputs;
	if (!inputs.length) return c.json({ error: "missing inputs (string[])" }, 400);
	// Bound the passthrough — it's an open door to a GPU host; CORS is not access control.
	if (inputs.length > EMBED_MAX_INPUTS) {
		return c.json({ error: `too many inputs (max ${EMBED_MAX_INPUTS})` }, 400);
	}
	if (inputs.some((s) => (s as string).length > EMBED_MAX_INPUT_CHARS)) {
		return c.json({ error: `input too long (max ${EMBED_MAX_INPUT_CHARS} chars each)` }, 400);
	}

	let res: Response;
	let encoder: string;
	const signal = AbortSignal.timeout(15000);
	try {
		encoder = await embeddingIdentity(signal);
		res = await fetcher(`${cfg.embedBase}/embed`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ inputs, truncate: false, normalize: true }),
			signal,
		});
	} catch (err) {
		console.error("[proxy] embed fetch failed:", err);
		return c.json({ error: "embed backend unreachable" }, 502);
	}
	if (!res.ok) {
		return c.json({ error: `embed backend ${res.status}` }, 502);
	}
	const vectors = await res.json().catch(() => null);
	const dimension = Array.isArray(vectors?.[0]) ? vectors[0].length : 0;
	if (!Array.isArray(vectors) || vectors.length !== inputs.length || !dimension ||
		vectors.some((v: unknown) => !Array.isArray(v) || v.length !== dimension ||
			v.some((n: unknown) => typeof n !== "number" || !Number.isFinite(n)))) {
		return c.json({ error: "invalid embedding response" }, 502);
	}
	try {
		if (await embeddingIdentity(signal) !== encoder) throw new Error("encoder changed during batch");
	} catch (err) {
		console.error("[proxy] embedding identity failed:", err);
		return c.json({ error: "embedding identity unavailable or changed" }, 502);
	}
	return c.json({ encoder, embeddings: vectors });
});

  let sttActive = 0;
  app.on("POST", ["/v1/audio/transcriptions", "/api/asr-http"], limit("speech"), async c => {
    if (!profile || !cfg.sttBase) return c.json({error: {code: "speech_unavailable"}}, 503);
    if (sttActive >= profile.limits.speechConcurrency) return c.json({error: {code: "speech_busy"}}, 429);
    sttActive++;
    try {
      const bytes = await c.req.arrayBuffer();
      if (bytes.byteLength > profile.limits.speechMaxBytes) return c.json({error: {code: "speech_body_too_large"}}, 413);
      const r = await fetcher(`${cfg.sttBase}/v1/audio/transcriptions`, {method: "POST", headers: {"Content-Type": c.req.header("Content-Type") ?? "application/octet-stream"}, body: bytes, signal: AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(profile.limits.speechTimeoutMs)])});
      const data = await r.json(); if (!r.ok || typeof data.text !== "string") throw new Error("invalid transcription response");
      return c.json(data);
    } catch (error) { log({stage: "speech", status: "failed", error: error instanceof Error ? error.name : "unknown"}); return c.json({error: {code: "speech_failed"}}, 502); }
    finally { sttActive--; }
  });
  if (profile && cfg.ttsBase) registerVoiceRoutes(app, new VoiceBroker({endpoints: [{ttsUrl: "/api/tts_streaming"}], capacity: profile.limits.speechConcurrency, heartbeatSec: 30}), limit("voice"));
  else app.post("/voice/lease", c => c.json({error: {code: "speech_unavailable"}}, 503));
  app.get("/v1/corpus/source/:handle", limit("source"), async c => {
    try {
      const upstream = await fetcher(`${cfg.contentBase}/v1/corpus/source/${encodeURIComponent(c.req.param("handle"))}`, {signal: c.req.raw.signal});
      return new Response(upstream.body, {status: upstream.status, headers: {"Content-Type": upstream.headers.get("Content-Type") ?? "application/octet-stream", "Content-Disposition": upstream.headers.get("Content-Disposition") ?? "attachment", "Content-Security-Policy": "sandbox; default-src 'none'", "X-Content-Type-Options": "nosniff"}});
    } catch { return c.json({error: {code: "source_unavailable"}}, 502); }
  });
  app.get("*", async c => {
    const pathname = new URL(c.req.url).pathname;
    if (pathname.startsWith("/v1/") || pathname.startsWith("/voice/")) return c.notFound();
    let filePath: string;
    try {
      const root = realpathSync(cfg.frontendDir);
      const candidate = resolve(root, `.${decodeURIComponent(pathname)}`);
      if (candidate !== root && !candidate.startsWith(root + sep)) return c.notFound();
      const file = Bun.file(candidate);
      filePath = await file.exists() && pathname !== "/" ? realpathSync(candidate) : realpathSync(resolve(root, "index.html"));
      if (!filePath.startsWith(root + sep)) return c.notFound();
    } catch { return c.notFound(); }
    return new Response(Bun.file(filePath), {headers: {"X-Content-Type-Options": "nosniff"}});
  });
  return {app, queue, profile};
}
const {app, profile} = createGateway();
const speech = speechBridge(config.ttsBase, profile?.limits.speechConcurrency ?? 0, profile?.limits.speechTimeoutMs ?? 1000, profile?.limits.speechMaxBytes ?? 1024);
export default {hostname: config.host, port: config.port, idleTimeout: 0,
  fetch(request: Request, server: Bun.Server<import("./speech-socket").SpeechSocket>) {
    if (new URL(request.url).pathname === "/api/tts_streaming") return speech.upgrade(request, server);
    return app.fetch(request, server);
  }, websocket: speech.websocket,
};
