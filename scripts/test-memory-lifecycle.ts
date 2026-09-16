import assert from "node:assert/strict";
import { PipelineRuntime, PIPELINE_STATE_KEY, PIPELINE_STORE, type PipelineDeps } from "../src/pipeline.ts";
import { Graph } from "../src/kg/graph.ts";
import { makeCompletion } from "../src/kg/ingest.ts";

const deferred = () => { let resolve!: () => void; const promise = new Promise<void>((r) => { resolve = r; }); return { promise, resolve }; };
function setup(loop?: PipelineDeps["runLoop"], summary = "[NO_ENTRY]") {
  const values = new Map<string, unknown>(); let consent = "granted"; let graph = Graph.empty();
  const costs: string[] = []; let saves = 0;
  const backend = {
    async get<T>(store: string, key: string) { return (values.get(`${store}/${key}`) ?? null) as T | null; },
    async set(store: string, key: string, value: unknown) { values.set(`${store}/${key}`, structuredClone(value)); },
    async delete(store: string, key: string) { values.delete(`${store}/${key}`); },
    async transaction<T>(_stores: string[], _mode: string, callback: (tx: any) => Promise<T>) { return callback(this); },
  };
  const runtime = new PipelineRuntime({ backend, getGraph: () => graph, saveGraph: async () => { saves++; },
    embed: async () => null, getModel: () => ({} as any), getBaseUrl: () => "invalid", getModelId: () => "test",
    getAuth: () => "", getConsent: () => consent, addCost: (_a, _b, session) => costs.push(session),
    onStateChange: () => {}, onActivity: () => {},
    completion: () => async () => summary, runLoop: loop ?? (async () => []),
  });
  return { runtime, backend, values, costs, get saves() { return saves; },
    consent(value: string) { consent = value; }, replaceGraph() { graph = Graph.empty(); }, graph: () => graph };
}
const message = (text: string) => [{ role: "user", content: text, timestamp: 1 }] as any;

// Every queued exchange runs, retaining the originating session even after switching.
{
  const entered = deferred(), release = deferred(); const transcripts: string[] = [];
  let first = true;
  const h = setup(async (messages) => {
    transcripts.push(String((messages[0] as any).content));
    if (first) { first = false; entered.resolve(); await release.promise; }
    return [];
  });
  await h.runtime.init(); h.runtime.startSession("one");
  h.runtime.onTurnEnd(() => message("first"), false); await entered.promise;
  h.runtime.onTurnEnd(() => message("second"), false);
  h.runtime.startSession("two"); h.runtime.onTurnEnd(() => message("third"), false);
  release.resolve(); await h.runtime.whenIdle();
  assert.equal(transcripts.length, 6); assert(transcripts[2].includes("second"));
  assert.deepEqual(h.costs, ["one", "one", "one", "one", "two", "two"]);
  assert.equal(h.saves, 3);
}
// A revoked active loop cannot write via a previously captured tool; queued ticks disappear.
{
  const entered = deferred(), release = deferred(); let rejected = false; let calls = 0;
  const h = setup(async (_messages, context) => {
    calls++; entered.resolve(); await release.promise;
    const add = context.tools!.find((t) => t.name === "add_term")!;
    try { await add.execute("id", { label: "orchard", description: "Fruit cultivation." }, undefined, undefined); }
    catch { rejected = true; }
    return [];
  });
  await h.runtime.init(); h.runtime.startSession("one");
  h.runtime.onTurnEnd(() => message("first"), false); await entered.promise;
  h.runtime.onTurnEnd(() => message("second"), false);
  h.consent("declined"); const stopped = h.runtime.cancel(); h.replaceGraph(); release.resolve(); await stopped;
  assert(rejected); assert.equal(calls, 1); assert.equal(h.graph().thoughts.size, 0); assert.equal(h.saves, 0);
  h.runtime.onTurnEnd(() => message("third"), false); await h.runtime.whenIdle(); assert.equal(calls, 1);
}
// Successful tool actions survive a later failed provider call.
{
  let calls = 0;
  const h = setup(async (_messages, context) => {
    if (calls++ === 0) {
      await context.tools!.find((t) => t.name === "add_term")!.execute("id", { label: "orchard", description: "Fruit cultivation." }, undefined, undefined);
      throw new Error("synthetic provider failure");
    }
    return [];
  });
  await h.runtime.init(); h.runtime.startSession("one"); h.runtime.onTurnEnd(() => message("first"), false);
  await h.runtime.whenIdle(); assert(h.runtime.snapshot().buffers.audit[0].actions.length);
  assert.equal(h.graph().thoughts.size, 1);
  assert(h.values.has(`${PIPELINE_STORE}/${PIPELINE_STATE_KEY}`));
}
// A failed load cannot replace recoverable persisted state with defaults.
{
  const h = setup(); h.backend.get = async () => { throw new Error("unreadable"); };
  await assert.rejects(() => h.runtime.init()); await assert.rejects(() => h.runtime.persist());
  h.runtime.onTurnEnd(() => message("first"), false); assert.equal(h.saves, 0); assert.equal(h.values.size, 0);
}
// Stable conversation keys replace, rather than duplicate, summary entries.
{
  const h = setup(); await h.runtime.init(); h.runtime.startSession("restored-session");
  h.runtime.setRunningContext([{ sessionKey: "restored-session", ts: "2026-01-01", text: "Private context" }]);
  assert.equal(h.runtime.runningContextBlock(), ""); h.runtime.startSession("another");
  assert(h.runtime.runningContextBlock().includes("Private context")); h.consent("declined");
  assert.equal(h.runtime.runningContextBlock(), "");
}
// Non-streaming completion rejects truncated/malformed success envelopes, retaining prior summaries.
{
  const original = globalThis.fetch;
  try {
    for (const body of [{}, { choices: [{ finish_reason: "length", message: { content: "partial" } }] }, { choices: [{ finish_reason: "stop", message: {} }] }]) {
      globalThis.fetch = async () => new Response(JSON.stringify(body), { status: 200 });
      await assert.rejects(() => makeCompletion({ baseUrl: "https://invalid", model: "test" })([]));
    }
    globalThis.fetch = async () => new Response(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: "valid" } }] }));
    assert.equal(await makeCompletion({ baseUrl: "https://invalid", model: "test" })([]), "valid");
  } finally { globalThis.fetch = original; }
}

// Corrupt nested records are rejected before replacement; memory tool pairs are removed together.
{
  const { validatePipelineState, validateSttLexicon, withoutPersonalMemory } = await import("../src/memory-state.ts");
  assert.throws(() => validateSttLexicon({ autoReplace: [null], mistranscriptions: [] }));
  assert.throws(() => validateSttLexicon({ autoReplace: [], mistranscriptions: [{ spoken: "word" }] }));
  const h = setup(); await h.runtime.init();
  const snapshot = h.runtime.snapshot(); (snapshot.buffers.audit as unknown[]) = [null];
  assert.throws(() => validatePipelineState(snapshot));
  const clean = withoutPersonalMemory([
    { role: "memory-context", block: "private" },
    { role: "assistant", content: [{type: "toolCall", id: "a", name: "memory_search", arguments: {}}, {type: "toolCall", id: "b", name: "web_search", arguments: {}}] },
    { role: "toolResult", toolCallId: "a", toolName: "memory_search", content: [{type:"text",text:"private"}] },
    { role: "toolResult", toolCallId: "b", toolName: "web_search", content: [{type:"text",text:"public"}] },
  ] as any);
  assert.equal(clean.length, 2); assert.equal((clean[0] as any).content.length, 1);
  assert.equal((clean[0] as any).content[0].id, (clean[1] as any).toolCallId);
}

// Summary admission uses exact abstention and actual update order.
{
  const h = setup(undefined, "The user discussed the literal token [NO_ENTRY].");
  await h.runtime.init();
  h.runtime.setRunningContext([
    { sessionKey: "newer", ts: "2026-01-02", text: "Earlier update" },
    { sessionKey: "older", ts: "2026-01-01", text: "Old text" },
  ]);
  h.runtime.startSession("older"); h.runtime.onTurnEnd(() => message("new discussion"), false);
  await h.runtime.whenIdle();
  assert.equal(h.runtime.getRunningContext()[0].sessionKey, "older");
  assert(h.runtime.getRunningContext()[0].text.includes("[NO_ENTRY]"));
  assert.equal(h.runtime.getRunningContext().length, 2);
}
// A saved present-null snapshot is corruption, never an empty-state migration.
{
  const h = setup();
  assert.throws(() => h.runtime.loadSnapshot({ revision: 1, graph: {present:false}, consent: {present:false},
    pipeline: {present:true, value:null}, legacyPipeline: {} } as any));
  await assert.rejects(() => h.runtime.persist());
}
console.log("memory lifecycle regressions passed");
