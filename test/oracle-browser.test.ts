import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { EvidenceLedger, createCorpusTools, validateEvidence, resolveCorpusCitation } from "../src/corpus-tools.js";
import { validateProfile, loadReleaseProfile, GATEWAY_BASE } from "../src/local-model.js";
import { admitPayload, beginRequest, serializeModelRequest } from "../src/oracle-runtime.js";
import { compactContext } from "../src/oracle-context.js";
import type { AgentMessage } from "@earendil-works/pi-agent-core";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
const id = `p:${"a".repeat(64)}:${"b".repeat(64)}`;
const source = { passage_id: id, document_id: "manual", source_revision: "c".repeat(64), extraction_revision: "v1", title: "Reference", edition: "1", section: ["Units"], page: { index: 0, label: "1", coordinates: null, anchor: null }, excerpt: "Keep the units.", complete: true, previous: null, next: null, flags: [], source: { url: `/v1/corpus/source/${encodeURIComponent(id)}`, sha256: "c".repeat(64), media_type: "text/plain", origin: "https://example.invalid/manual" } };
const profile = { id: "candidate", model: { id: "local-test", name: "Test", contextWindow: 2048, maxTokens: 256, reasoning: false, input: ["text"] }, roles: Object.fromEntries(["chat", "audit", "memory", "summary", "compaction"].map(role => [role, { maxInputTokens: 1792, maxOutputTokens: 256, maxStageOutputTokens: 1024 }])), limits: { queueTimeoutMs: 1000, executionTimeoutMs: 1000 } };

test("citation handles survive stored-ledger restoration and cannot become arbitrary local URLs", () => {
 const ledger = new EvidenceLedger(); ledger.remember([validateEvidence(source)]);
 const restored = new EvidenceLedger(); restored.restore([ledger.message()]);
 assert.equal(restored.resolve(id)?.document_id, "manual");
 assert.equal(restored.resolve("invented"), undefined);
 assert.equal(resolveCorpusCitation(`${GATEWAY_BASE}/corpus/source/%ZZ`, restored, "http://localhost").kind, "unknown");
 assert.throws(() => validateEvidence({ ...source, source: { ...source.source, url: "javascript:alert(1)" } }), /source link/);
 assert.throws(() => validateEvidence({ ...source, source_revision: "different-edition" }), /evidence/);
});

test("corpus tools work with no consent or memory dependency and retain explicit degradation", async () => {
 const ledger = new EvidenceLedger();
 let request: RequestInit | undefined;
 globalThis.fetch = async (_url, opts) => { request = opts; return Response.json({ generation: "a".repeat(64), profile_id: "hybrid", status: "degraded", hits: [source], degradation: ["dense_unavailable"] }); };
 const tool = createCorpusTools(ledger)[0];
 const result = await tool.execute("call", { query: "units" });
 assert.equal(ledger.resolve(id)?.title, "Reference");
 assert.match(JSON.stringify(result.content), /dense_unavailable/);
 assert.equal((request?.headers as Record<string,string>).Authorization, undefined);
 globalThis.fetch = async () => Response.json({ generation: "a", profile_id: "x", status: "ok", hits: [{ ...source, passage_id: "unknown" }] });
 await assert.rejects(tool.execute("call", { query: "x" }), /invalid source/);
});

test("release budgets reject missing, impossible, and nonfinite limits", () => {
 assert.equal(validateProfile(profile).id, "candidate");
 assert.throws(() => validateProfile({ ...profile, roles: {} }), /budget/);
 assert.throws(() => validateProfile({ ...profile, model: { ...profile.model, contextWindow: 100 } }), /budget/);
 assert.throws(() => validateProfile({ ...profile, limits: { ...profile.limits, executionTimeoutMs: Infinity } }), /profile/);
});

test("serialized tokenizer counts enforce input ceiling and profile output budget", async () => {
 globalThis.fetch = async (url) => String(url).endsWith("/profile") ? Response.json({ ready: true, profile }) : Response.json({ tokens: 1793 });
 await loadReleaseProfile();
 await assert.rejects(admitPayload({ model: "wrong", messages: [] }, "chat"), /too large/);
 globalThis.fetch = async () => Response.json({ tokens: 1792 });
 const admitted = await admitPayload({ model: "wrong", messages: [], max_tokens: 128, max_completion_tokens: 50000 }, "chat") as any;
 assert.equal(admitted.max_tokens, 128); assert.equal(admitted.max_completion_tokens, undefined); assert.equal(admitted.model, "local-test");
});

test("provider serialization includes tool schema without issuing a completion", async () => {
 let calls = 0;
 globalThis.fetch = async (url) => { calls++; assert.match(String(url), /profile$/); return Response.json({ ready: true, profile }); };
 await loadReleaseProfile();
 const payload = await serializeModelRequest({ systemPrompt: "Read sources", messages: [{ role: "user", content: "Question", timestamp: 1 }], tools: createCorpusTools(new EvidenceLedger()) }) as any;
 assert.equal(payload.model, "local-test");
 assert.equal(payload.tools.length, 2);
 assert.equal(calls, 1);
});

test("abort reaches gateway cancellation and request cleanup stops polling", async () => {
 const calls: RequestInit[] = [];
 globalThis.fetch = async (_url, init) => { calls.push(init ?? {}); return Response.json({}); };
 const controller = new AbortController();
 const request = beginRequest("chat", "session", controller.signal);
 controller.abort(); request.finish("interrupted");
 await Promise.resolve();
 assert.equal(calls.length, 1); assert.equal(calls[0].method, "DELETE");
});

test("compaction preserves evidence metadata and entire recent turn, refusing nonreducing summaries", async () => {
 const ledger = new EvidenceLedger(); ledger.remember([validateEvidence(source)]);
 const messages: AgentMessage[] = [{ role: "user", content: "Old question", timestamp: 1 }, { role: "user", content: "Recent question", timestamp: 2 }];
 const result = await compactContext({ convert: values => values.filter(message => message.role === "user"), messages, ledger: ledger.message(), inputBudget: 100, summaryInputBudget: 100,
 measure: async items => items.some(m => m.role === "compactionSummary") ? 70 : 120, measureSummary: async () => 20, summarize: async () => "Earlier requirements; source details summarized, reread.", isCurrent: () => true });
 assert.equal(result[0].role, "compactionSummary"); assert.equal(result[1].role, "corpus-ledger"); assert.equal(result[2], messages[1]);
 await assert.rejects(compactContext({ convert: values => values.filter(message => message.role === "user"), messages, ledger: ledger.message(), inputBudget: 100, summaryInputBudget: 100, measure: async () => 120, measureSummary: async () => 20, summarize: async () => "Not shorter", isCurrent: () => true }), /could not reduce/);
});

test("non-streaming completions reject unknown usage before publishing accounting", async () => {
 const { makeCompletion } = await import("../src/kg/ingest.js");
 let usage: unknown;
 let accounted = 0;
 globalThis.fetch = async (url, init) => {
  if (String(url).endsWith("/profile")) return Response.json({ ready: true, profile });
  if (String(url).endsWith("/tokenize")) return Response.json({ tokens: 20 });
  assert.equal((init?.headers as Record<string,string>).Authorization, undefined);
  return Response.json({ choices: [{ message: { content: "Summary" }, finish_reason: "stop" }], usage });
 };
 await loadReleaseProfile();
 const complete = makeCompletion({ baseUrl: "/v1", model: "local-test", role: "summary", onUsage: () => accounted++ });
 for (usage of [undefined, { prompt_tokens: 1, completion_tokens: null }, { prompt_tokens: 1, completion_tokens: -1 }, { prompt_tokens: 1, completion_tokens: 0 }]) {
  await assert.rejects(complete([{ role: "user", content: "summarize" }]), /usage/);
 }
 assert.equal(accounted, 0);
 usage = { prompt_tokens: 20, completion_tokens: 3 };
 assert.equal(await complete([{ role: "user", content: "summarize" }]), "Summary");
 assert.equal(accounted, 1);
});


test("exhausted stage budget stops before any provider or tokenizer request", async () => {
 const { createLocalStreamFn } = await import("../src/oracle-runtime.js");
 const { LOCAL_MODEL } = await import("../src/local-model.js");
 let calls = 0;
 globalThis.fetch = async () => { calls++; throw new Error("No network call is permitted after exhaustion"); };
 await assert.rejects(createLocalStreamFn("memory", () => "session", () => 0)(LOCAL_MODEL, { messages: [] }), /budget exhausted/);
 assert.equal(calls, 0);
});

test("already-aborted requests fail before publishing or scheduling request state", () => {
 const controller=new AbortController();controller.abort();
 let requests=0;globalThis.fetch=async()=>{requests++;return Response.json({});};
 assert.throws(()=>{const request=beginRequest('chat','cancelled',controller.signal);request.finish('interrupted');},{name:'AbortError'});
 assert.equal(requests,0);
});
