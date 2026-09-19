import assert from "node:assert/strict";
import { test, afterEach } from "node:test";
import { Graph } from "../src/kg/graph.js";
import { RecallSession } from "../src/recall-session.js";
import { ConversationHistory, createConversationHistoryTool, historyWithoutPersonalMemory } from "../src/conversation-history.js";
import { createLocalStreamFn, serializeModelRequest, countRequestTokens } from "../src/oracle-runtime.js";
import { loadReleaseProfile, proxyChatModel } from "../src/local-model.js";
import { formatTranscript } from "../src/pipeline.js";

const fetchOriginal = globalThis.fetch;
afterEach(() => { globalThis.fetch = fetchOriginal; });
const profile = { id: "recall-fixture", model: { id: "fixture", name: "Fixture", contextWindow: 20000, maxTokens: 256, reasoning: false, input: ["text"] }, roles: Object.fromEntries(["chat", "audit", "memory", "summary", "compaction"].map(role => [role, {maxInputTokens: 18000, maxOutputTokens: 256, maxStageOutputTokens: 1024}])), limits: {queueTimeoutMs: 1000, executionTimeoutMs: 1000} };

test("real provider serializer and HTTP admission retain exact recall separately from model history", async () => {
  let status = 200;
  const payloads: any[] = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.endsWith("/profile")) return Response.json({ready: true, profile});
    const body = init?.body ? JSON.parse(String(init.body)) : input instanceof Request ? await input.json() : {};
    if (url.endsWith("/tokenize")) return Response.json({tokens: JSON.stringify(body).length});
    if (url.endsWith("/chat/completions")) {
      payloads.push(body);
      if (status !== 200) return Response.json({error: {message: "fixture unavailable"}}, {status});
      return new Response('data: {"id":"fixture","choices":[{"index":0,"delta":{"role":"assistant","content":"done"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', {headers: {"content-type":"text/event-stream"}});
    }
    throw new Error(`Unexpected request ${url}`);
  };
  await loadReleaseProfile();
  let graph = Graph.empty();
  graph.getOrCreate("orchard", "Fruit trees."); graph.getOrCreate("cistern", "Stored rainwater.");
  const archive = new ConversationHistory();
  let active = true;
  const recall = new RecallSession({policy: {messageTerms: 8, toolTerms: 4, reinforcementBase: 2}, active: () => active, graph: () => graph,
    updateCounters: async operation => { const draft = new Graph(structuredClone(graph.serialize())); const result = operation(draft); graph = draft; return result; },
    onDelivery: receipt => archive.capture({role: "memory-delivery", receipt, timestamp: 1}),
  });
  const context = {systemPrompt: "Use references.", messages: [{role: "user" as const, content: "orchard", timestamp: 1}], tools: []};
  const send = async () => {
    const request = await recall.prepare(context, async c => countRequestTokens(await serializeModelRequest(c), "chat"), 18000);
    const stream = await createLocalStreamFn("chat", () => "session", undefined, request.admitted)(proxyChatModel(), request.context);
    return stream.result();
  };
  await recall.observe("message", "orchard");
  const prep = await recall.prepare(context, async () => 1, 18000);
  assert.equal(archive.messages().length, 0, "preparation alone is not admitted evidence");
  assert.equal(context.messages.length, 1, "transient pool must not mutate model history");
  assert.equal((await send()).stopReason, "stop");
  assert.equal(archive.messages().length, 1);
  const first = archive.messages()[0] as any;
  assert.equal(first.receipt.block, payloads[0].messages.at(-1).content);
  assert.match(formatTranscript(archive.messages()), /ADMITTED PERSONAL MEMORY/);
  await recall.observe("tool", "The source discusses a cistern.");
  await send();
  assert.equal(graph.get("cistern")!.hit_count_tool, 1);
  assert.equal(graph.get("cistern")!.hit_count, 1);
  assert.equal(graph.get("orchard")!.hit_count_tool ?? 0, 0);
  assert.deepEqual((archive.messages()[1] as any).receipt.terms.map((t: any) => t.label), ["orchard", "cistern"]);
  status = 503;
  assert.equal((await send()).stopReason, "error");
  assert.equal(archive.messages().length, 2, "rejected requests create no receipt");
  active = false; recall.reset();
  prep.admitted("late-response");
  assert.equal(archive.messages().length, 2, "late success cannot republish revoked memory");
  assert.equal(historyWithoutPersonalMemory(archive.messages()[0]), undefined);
  const restored = new ConversationHistory(archive.snapshot());
  const tool = createConversationHistoryTool(restored, () => {});
  const page = JSON.parse((await tool.execute("read", {id: restored.snapshot().records[0].id})).content[0].text!);
  assert.match(page.provenance, /not a user statement/);
});

test("tool counters survive merge and malformed imported attribution is refused", () => {
  const graph = Graph.empty();
  const first = graph.getOrCreate("garden", "Growing area.");
  const second = graph.getOrCreate("plot", "Growing area.");
  graph.fire(first, "tool"); graph.fire(first); graph.fire(second, "tool");
  graph.merge("plot", "garden");
  assert.equal(graph.get("garden")!.hit_count, 3);
  assert.equal(graph.get("garden")!.hit_count_tool, 2);
  const asset = structuredClone(graph.serialize());
  asset.thoughts[first.id].hit_count_tool = 4;
  assert.throws(() => new Graph(asset), /Invalid memory term/);
});

test("replacement graph or revoked authority cannot admit prepared personal recall", async () => {
  let graph = Graph.empty(); graph.getOrCreate("orchard", "Fruit trees.");
  let active = true;
  const receipts: unknown[] = [];
  const recall = new RecallSession({ policy: {messageTerms: 3, toolTerms: 2, reinforcementBase: 2}, active: () => active, graph: () => graph,
    updateCounters: async operation => operation(graph), onDelivery: receipt => receipts.push(receipt) });
  await recall.observe("message", "orchard");
  const context = {messages: [{role: "user" as const, content: "question", timestamp: 1}]};
  let swapped = false;
  await assert.rejects(recall.prepare(context, async () => { if (!swapped) { swapped = true; graph = new Graph(structuredClone(graph.serialize())); } return 1; }, 100), /Personal recall changed/);
  const prepared = await recall.prepare(context, async () => 1, 100);
  active = false; recall.reset(); prepared.admitted("late");
  assert.equal(receipts.length, 0);
  const off = await recall.prepare(context, async () => { throw new Error("must not inspect when off"); }, 100);
  assert.equal(off.context, context);
});
