import "./test-env";
import { afterEach, beforeAll, expect, test } from "bun:test";
import { forwardCompletion } from "./openrouter";
let app: typeof import("./server").app;
let db: typeof import("./server").db;
const originalFetch = globalThis.fetch;
beforeAll(async () => { ({ app, db } = await import("./server")); });
afterEach(() => { globalThis.fetch = originalFetch; });
const identity = { model_id: "test-encoder", model_sha: "1111111111111111111111111111111111111111", model_type: { embedding: { pooling: "mean" } } };
function upstream(data: unknown) { globalThis.fetch = (async (url: unknown) => Response.json(String(url).endsWith("/info") ? identity : data)) as unknown as typeof fetch; }
function embed(inputs: unknown) { return app.request("/v1/embed", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ inputs }) }); }
test("malformed search success is a backend failure", async () => {
 upstream({ error: "failed" });
 expect((await app.request("/v1/web-search?q=tractor")).status).toBe(502);
});
test("empty search with failed engines is not a negative search result", async () => {
 upstream({ results: [], unresponsive_engines: [["engine", "timeout"]] });
 expect((await app.request("/v1/web-search?q=tractor")).status).toBe(502);
});
test("partial search carries degradation; legitimate empty search stays empty", async () => {
 upstream({ results: [{ title: "Manual", url: "https://example.org/manual", content: "Repair" }], unresponsive_engines: [["engine", "timeout"]] });
 const res = await app.request("/v1/web-search?q=tractor");
 expect(res.status).toBe(200);
 expect((await res.json()).degraded).toBe(true);
 upstream({ results: [] });
 expect((await (await app.request("/v1/web-search?q=tractor")).json()).results).toEqual([]);
});
test("embed rejects mixed input rather than changing cardinality", async () => {
 upstream([[1, 2]]);
 expect((await embed(["one", 7, "two"])).status).toBe(400);
});
test("embed rejects wrong cardinality and malformed vectors", async () => {
 for (const body of [[[1]], [[1], [2, 3]], [["bad"], [2]], { error: "failed" }]) {
  upstream(body);
  expect((await embed(["one", "two"])).status).toBe(502);
 }
});
test("valid vectors preserve positions", async () => {
 upstream([[1, 2], [3, 4]]);
 const res = await embed(["one", "two"]);
 expect(res.status).toBe(200);
 const data = await res.json();
 expect(data.embeddings).toEqual([[1, 2], [3, 4]]);
 expect(JSON.parse(data.encoder).model_sha).toBe("1111111111111111111111111111111111111111");
});
test("invalid output limits never reach reservation or upstream", async () => {
 db.createPrincipal({ id: "limit-contract", type: "anon", upstreamKey: null, credit: 10, tier: "free" });
 let calls = 0;
 globalThis.fetch = (async () => { calls++; return Response.json({ choices: [], usage: { cost: 0 } }); }) as unknown as typeof fetch;
 for (const value of [-10000000, 0, 1.5, "8", null]) {
  const res = await app.request("/v1/chat/completions", { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer limit-contract" }, body: JSON.stringify({ model: "moonshotai/kimi-k3", max_tokens: value, messages: [] }) });
  expect(res.status).toBe(400);
 }
 expect(calls).toBe(0);
 expect(db.getPrincipal("limit-contract")?.credit_remaining).toBe(10);
});
test("missing or invalid cost preserves fallback instead of free usage", async () => {
 for (const usage of [{ prompt_tokens: 1 }, { cost: -1 }, { cost: "1" }]) {
  upstream({ choices: [], usage });
  const result = await forwardCompletion({ base: "https://example.invalid", upstreamKey: "test", body: {} });
  expect(await result.usage).toBeNull();
 }
 upstream({ choices: [], usage: { cost: 0, prompt_tokens: 1 } });
 expect(await (await forwardCompletion({ base: "https://example.invalid", upstreamKey: "test", body: {} })).usage).toEqual({ cost: 0, promptTokens: 1, completionTokens: 0 });
});

test("encoder identity absence and changes reject the batch", async () => {
 let infoCalls = 0;
 globalThis.fetch = (async (url: unknown) => Response.json(String(url).endsWith("/info") ?
  { ...identity, model_sha: ++infoCalls === 1 ? "1111111111111111111111111111111111111111" : "2222222222222222222222222222222222222222" } : [[1, 2]])) as unknown as typeof fetch;
 expect((await embed(["one"])).status).toBe(502);
 globalThis.fetch = (async () => Response.json({ model_id: "unknown" })) as unknown as typeof fetch;
 expect((await embed(["one"])).status).toBe(502);
});
test("embedding requests disable truncation and normalize vectors", async () => {
 let requestBody: unknown;
 globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
  if (String(url).endsWith("/info")) return Response.json(identity);
  requestBody = JSON.parse(String(init?.body));
  return Response.json([[1, 2]]);
 }) as unknown as typeof fetch;
 expect((await embed(["one"])).status).toBe(200);
 expect(requestBody).toEqual({ inputs: ["one"], truncate: false, normalize: true });
});

test("TEI info requires a pinned weight revision and preserves model_dtype", async () => {
 const liveShape = { model_id: "sentence-transformers/all-MiniLM-L6-v2", model_sha: null,
  model_dtype: "float32", served_model_name: "sentence-transformers/all-MiniLM-L6-v2",
  model_type: { embedding: { pooling: "mean" } }, max_input_length: 256,
  auto_truncate: true, version: "1.9.3", sha: "f9a0643efb091b2a95dd40f22ce82c5d30b04205", docker_label: "sha-f9a0643" };
 for (const revision of [null, "main", "1110a243fdf4706b3f48f1d95db1a4f5529b4d41"]) {
  globalThis.fetch = (async (url: unknown) => Response.json(String(url).endsWith("/info") ?
   { ...liveShape, model_sha: revision } : [[1, 2]])) as unknown as typeof fetch;
  const response = await embed(["one"]);
  if (!revision || revision === "main") expect(response.status).toBe(502);
  else {
   expect(response.status).toBe(200);
   const encoder = JSON.parse((await response.json()).encoder);
   expect(encoder.model_sha).toBe(revision);
   expect(encoder.model_dtype).toBe("float32");
   expect(encoder.model_sha).not.toBe(liveShape.sha);
  }
 }
});
