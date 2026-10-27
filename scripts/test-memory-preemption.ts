import assert from "node:assert/strict";
import { test } from "node:test";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { PipelineRuntime, PIPELINE_STORE, type PipelineDeps, type PipelineSnapshot } from "../src/pipeline.js";
import { MemoryStorage } from "../src/memory-storage.js";
import { IndexedDBStorageBackend } from "../src/pi-web-ui/storage/backends/indexeddb-storage-backend.js";
import { Graph } from "../src/kg/graph.js";
import type { GraphAsset } from "../src/kg/types.js";
import { isPreemptedCompletionError } from "../src/oracle-runtime.js";
import { MemoryBudgetError } from "../src/memory-handoffs.js";

// Regression: a foreground chat must preempt a running memory tick mid-round.
// The gateway aborts the background request and answers with code "preempted";
// the pipeline parks the stage (durable state returns to pending, the aborted
// draft is discarded) and re-runs it once the visitor's chat has finished. A
// preempted round must never mark the stage failed, never double-apply its
// memory writes, and never wedge the tick. Run: tsx scripts/test-memory-preemption.ts

globalThis.indexedDB = new IDBFactory();
globalThis.IDBKeyRange = IDBKeyRange;
const completed = () => [{ role: "assistant", content: [{ type: "text", text: "Complete" }], stopReason: "stop", usage: { input: 1, output: 1 } }] as any;
// The gateway's preemption answer, as the provider stream surfaces it.
const preempted = () => [{ role: "assistant", content: [{ type: "text", text: "" }], stopReason: "error", errorMessage: '{"code":"preempted"}', usage: { input: 1, output: 1 } }] as any;
const aborted = () => [{ role: "assistant", content: [{ type: "text", text: "" }], stopReason: "aborted", usage: { input: 1, output: 1 } }] as any;
const messages = [{ role: "user", content: "Remember orchard tools", timestamp: 1 }] as any;
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; };
const isAudit = (context: any) => !!context.tools.find((t: any) => t.name === "audit_handoff");
let serial = 0;
function backend(name = `preemption-${serial++}`) {
  return new IndexedDBStorageBackend({ dbName: name, version: 1,
    stores: ["lexicon", "pipeline", "memory-consent"].map(name => ({ name })) });
}
async function fixture(options: { raw?: ReturnType<typeof backend>; loop?: PipelineDeps["runLoop"]; foregroundActive?: () => boolean } = {}) {
  const raw = options.raw ?? backend(); const storage = new MemoryStorage(raw);
  const saved = await storage.load(); let graph = saved.graph.present ? new Graph(saved.graph.value as GraphAsset) : Graph.empty();
  let consent = "granted"; const errors: unknown[] = [];
  const runtime = new PipelineRuntime({ backend: raw, getGraph: () => graph, setGraph: next => { graph = next; },
    publishMemory: async (asset, state, archive, guard) => { await storage.save({ graph: asset, pipeline: state, ...(archive ? { archive } : {}) }, guard); },
    measureContext: async () => 1, getRoleInputBudget: () => 1000000, getRoleOutputBudget: () => 1000000,
    embed: async () => null, getModel: () => ({} as any), getBaseUrl: () => "invalid", getModelId: () => "fixture", getAuth: () => "not-persisted",
    getConsent: () => storage.invalidated ? "declined" : consent, addCost: () => {}, onStateChange: () => {}, onActivity: () => {},
    onError: error => { errors.push(error); }, foregroundActive: options.foregroundActive,
    runLoop: async (...args) => {
      const output = await (options.loop ?? (async () => completed()))(...args);
      const summaryDraft = args[1].tools!.find(tool => tool.name === "summary_draft");
      if (summaryDraft) await summaryDraft.execute("finish", { operation: "store", text: "The user maintains an orchard." }, undefined, undefined);
      else await args[1].tools!.find(tool => tool.name === "memory_finish")!.execute("finish", { outcome: "completed", reason: "Fixture completed" }, undefined, undefined);
      return output;
    }, completion: args => async () => { args.onUsage?.({ promptTokens: 1, completionTokens: 1 }); return "[NO_ENTRY]"; },
  });
  runtime.loadSnapshot(saved); runtime.startSession("conversation");
  return { runtime, storage, raw, graph: () => graph, errors, revoke: () => { consent = "declined"; return runtime.cancel(); } };
}
async function add(context: any, label = "orchard") {
  await context.tools.find((t: any) => t.name === "add_term").execute("call", { label, description: "A cultivated fruit garden." }, undefined, undefined);
}
async function until(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("condition not reached within timeout");
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

test("preemption detection matches both gateway renderings and rejects other failures", () => {
  assert.equal(isPreemptedCompletionError("preempted"), true); // streaming error frame
  assert.equal(isPreemptedCompletionError('503 {"code":"preempted","message":"preempted"}'), true); // buffered HTTP body
  assert.equal(isPreemptedCompletionError("Connection error."), false);
  assert.equal(isPreemptedCompletionError("Request was aborted"), false);
  assert.equal(isPreemptedCompletionError(undefined), false);
});

test("a budget-exhausted stage retries at a degraded effort and completes", async () => {
  let auditCalls = 0;
  const h = await fixture({ loop: async (_messages, context) => {
    if (isAudit(context) && auditCalls++ === 0) throw new MemoryBudgetError("allowance exhausted");
    return completed();
  } });
  h.runtime.onTurnEnd(() => messages, false);
  await h.runtime.whenIdle();
  assert.equal(auditCalls, 2);
  assert.deepEqual(h.runtime.snapshot().jobs![0]!.stages, { audit: "complete", memory: "complete", summary: "complete" });
  assert.equal(h.runtime.hasFailedWork, false);
});

test("a later successful retry clears the failed-work badge", async () => {
  let fail = true;
  const h = await fixture({ loop: async (_messages, context) => {
    if (isAudit(context) && fail) { fail = false; throw new Error("temporary stage failure"); }
    return completed();
  } });
  h.runtime.onTurnEnd(() => messages, false);
  await h.runtime.whenIdle();
  assert.equal(h.runtime.hasFailedWork, true);
  h.runtime.retryPending();
  await h.runtime.whenIdle();
  assert.equal(h.runtime.hasFailedWork, false);
});

test("an abort-shaped preemption (frame lost to teardown) parks like a preemption, never fails the stage", async () => {
  const entered = deferred(); let calls = 0; let chatBusy = true;
  const h = await fixture({ foregroundActive: () => chatBusy, loop: async (_messages, context) => {
    if (isAudit(context) && calls++ === 0) { entered.resolve(); return aborted(); }
    return completed();
  } });
  h.runtime.onTurnEnd(() => messages, false); await entered.promise;
  const parked = () => h.runtime.snapshot().jobs?.[0];
  await until(() => parked()?.stages.audit === "pending");
  // The interrupted round published no failure outcome: a transient abort is a
  // preemption whose SSE error frame lost the race to the connection teardown.
  assert.equal(h.runtime.activity.filter(a => a.line.includes("failed")).length, 0);
  chatBusy = false;
  await h.runtime.whenIdle();
  assert.deepEqual(h.runtime.snapshot().jobs![0]!.stages, { audit: "complete", memory: "complete", summary: "complete" });
  assert.equal(h.errors.length, 0);
});

test("an unknown round error while the foreground holds the machine parks like a preemption", async () => {
  const entered = deferred(); let calls = 0; let chatBusy = true;
  const h = await fixture({ foregroundActive: () => chatBusy, loop: async (_messages, context) => {
    if (isAudit(context) && calls++ === 0) { entered.resolve(); return [{ role: "assistant", content: [{ type: "text", text: "" }], stopReason: "error", errorMessage: "Connection error.", usage: { input: 1, output: 1 } }] as any; }
    return completed();
  } });
  h.runtime.onTurnEnd(() => messages, false); await entered.promise;
  const parked = () => h.runtime.snapshot().jobs?.[0];
  await until(() => parked()?.stages.audit === "pending");
  // The unknown error parked instead of failing: while a foreground chat runs,
  // the gateway kills background rounds only for foreground, so any round death
  // is a preemption in some rendering, connection-wrapped included.
  assert.equal(h.runtime.activity.filter(a => a.line.includes("failed")).length, 0);
  chatBusy = false;
  await h.runtime.whenIdle();
  assert.deepEqual(h.runtime.snapshot().jobs![0]!.stages, { audit: "complete", memory: "complete", summary: "complete" });
  assert.equal(h.errors.length, 0);
});

test("a preempted round parks the stage, then re-runs it exactly once when the chat finishes", async () => {
  const entered = deferred(); let calls = 0; let chatBusy = true;
  const h = await fixture({ foregroundActive: () => chatBusy, loop: async (_messages, context) => {
    await add(context); // the aborted draft edits memory mid-flight, before the preempt lands
    if (isAudit(context) && calls++ === 0) { entered.resolve(); return preempted(); }
    return completed();
  } });
  h.runtime.onTurnEnd(() => messages, false); await entered.promise;
  // Parked: the durable stage is pending again, the failed path never ran, and
  // the aborted draft (which added a term) committed nothing.
  const parked = () => h.runtime.snapshot().jobs?.[0];
  await until(() => parked()?.stages.audit === "pending");
  assert.equal(h.graph().thoughts.size, 0);
  assert.equal(h.runtime.activity.filter(a => a.agent === "audit" && a.line.includes("paused")).length, 1);
  chatBusy = false;
  await h.runtime.whenIdle();
  // The tick resumed and the whole job completed, with the write applied exactly
  // once — the aborted round's identical add_term did not survive to publication.
  assert.deepEqual(h.runtime.snapshot().jobs![0]!.stages, { audit: "complete", memory: "complete", summary: "complete" });
  assert.equal(h.graph().thoughts.size, 1);
  assert.equal(h.runtime.snapshot().buffers.audit.length, 1);
  assert.equal(h.errors.length, 0);
});

test("repeated preemption backs off and still completes; coverage is never marked failed", async () => {
  let preemptions = 0; let chatBusy = true;
  const h = await fixture({ foregroundActive: () => chatBusy, loop: async (_messages, context) => {
    await add(context);
    if (isAudit(context) && preemptions < 2) {
      // each retry is preempted by another message, which finishes shortly after
      preemptions++; chatBusy = true; setTimeout(() => { chatBusy = false; }, 100);
      return preempted();
    }
    return completed();
  } });
  h.runtime.onTurnEnd(() => messages, false);
  await h.runtime.whenIdle();
  assert.equal(preemptions, 2);
  assert.deepEqual(h.runtime.snapshot().jobs![0]!.stages, { audit: "complete", memory: "complete", summary: "complete" });
  assert.equal(h.runtime.snapshot().jobs![0]!.outcomes?.audit.kind, "completed");
  assert.equal(h.graph().thoughts.size, 1); // both aborted drafts were discarded
  assert.equal(h.runtime.snapshot().buffers.audit.length, 1);
  assert.equal(h.errors.length, 0);
});

test("repeated preemption fails only after the bounded retry budget is exhausted", async () => {
  let calls = 0; let chatBusy = false;
  const h = await fixture({ foregroundActive: () => chatBusy, loop: async (_messages, context) => {
    if (isAudit(context)) {
      calls++;
      chatBusy = true;
      setTimeout(() => { chatBusy = false; }, 100);
      return preempted();
    }
    return completed();
  } });
  h.runtime.onTurnEnd(() => messages, false);
  await h.runtime.whenIdle();
  assert.equal(calls, 4); // initial round plus three automatic retries
  assert.equal(h.runtime.snapshot().jobs![0]!.stages.audit, "failed");
  assert.equal(h.runtime.snapshot().jobs![0]!.stages.memory, "pending");
  assert.equal(h.runtime.activity.filter(a => a.agent === "audit" && a.line.includes("paused")).length, 3);
});

test("consent revoked while parked ends the tick without a wedge or a false failure", async () => {
  const entered = deferred(); let calls = 0;
  const h = await fixture({ foregroundActive: () => true, loop: async (_messages, context) => {
    await add(context);
    if (calls++ === 0) { entered.resolve(); return preempted(); }
    return completed();
  } });
  h.runtime.onTurnEnd(() => messages, false); await entered.promise;
  await until(() => h.runtime.snapshot().jobs?.[0]?.stages.audit === "pending");
  await h.revoke();
  await h.runtime.whenIdle(); // resolves: the parked stage must not spin forever
  assert.equal(h.runtime.snapshot().jobs!.length, 0); // cancellation cleared outstanding work
  assert.equal(h.graph().thoughts.size, 0);
  assert.equal(h.errors.length, 0);
});

test("a non-preemption transport error still fails the stage through the original path", async () => {
  let calls = 0;
  const h = await fixture({ foregroundActive: () => false, loop: async () => {
    if (calls++ === 0) return [{ role: "assistant", content: [], stopReason: "error", errorMessage: "Connection error.", usage: { input: 1, output: 1 } }] as any;
    return completed();
  } });
  h.runtime.onTurnEnd(() => messages, false); await h.runtime.whenIdle();
  assert.equal(h.runtime.snapshot().jobs![0].stages.audit, "failed");
  assert.equal(h.runtime.snapshot().jobs![0].stages.memory, "pending");
});

test("durable state during the park reads back on reload as resumable pending work", async () => {
  const entered = deferred(); let calls = 0; let chatBusy = true;
  const raw = backend("preemption-durable");
  const first = await fixture({ raw, foregroundActive: () => chatBusy, loop: async (_messages, context) => {
    await add(context);
    if (isAudit(context) && calls++ === 0) { entered.resolve(); return preempted(); }
    return completed();
  } });
  first.runtime.onTurnEnd(() => messages, false); await entered.promise;
  await until(() => first.runtime.snapshot().jobs?.[0]?.stages.audit === "pending");
  const durable = await raw.get<PipelineSnapshot>(PIPELINE_STORE, "state");
  assert.equal(durable!.jobs![0].stages.audit, "pending");
  assert.equal(durable!.jobs![0].messages.length, 1); // coverage input survives the park
  chatBusy = false;
  await first.runtime.whenIdle();
  assert.deepEqual(first.runtime.snapshot().jobs![0]!.stages, { audit: "complete", memory: "complete", summary: "complete" });
});
