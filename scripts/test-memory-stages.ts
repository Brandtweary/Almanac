import assert from "node:assert/strict";
import { test } from "node:test";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { PipelineRuntime, type PipelineDeps, type PipelineSnapshot } from "../src/pipeline.js";
import { MemoryStorage } from "../src/memory-storage.js";
import { IndexedDBStorageBackend } from "../src/pi-web-ui/storage/backends/indexeddb-storage-backend.js";
import { Graph } from "../src/kg/graph.js";
import type { GraphAsset } from "../src/kg/types.js";
import { validatePipelineState } from "../src/memory-state.js";

globalThis.indexedDB = new IDBFactory();
globalThis.IDBKeyRange = IDBKeyRange;
const completed = () => [{ role: "assistant", content: [{ type: "text", text: "Complete" }], stopReason: "stop", usage: { input: 1, output: 1 } }] as any;
const messages = [{ role: "user", content: "Remember orchard tools", timestamp: 1 }] as any;
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; };
let serial = 0;
function backend(name = `stages-${serial++}`) {
  return new IndexedDBStorageBackend({ dbName: name, version: 1,
    stores: ["lexicon", "pipeline", "memory-consent"].map(name => ({ name })) });
}
async function fixture(options: { raw?: ReturnType<typeof backend>; loop?: PipelineDeps["runLoop"]; summary?: PipelineDeps["completion"];
  roleLoop?: boolean; initialGraph?: GraphAsset; beforeWrite?: (state: PipelineSnapshot) => Promise<void>; afterWrite?: (state: PipelineSnapshot, graph: GraphAsset) => void } = {}) {
  const raw = options.raw ?? backend(); const storage = new MemoryStorage(raw);
  if (options.initialGraph) { await storage.load(); await storage.save({ graph: options.initialGraph }); }
  const saved = await storage.load(); let graph = saved.graph.present ? new Graph(saved.graph.value as GraphAsset) : Graph.empty();
  let consent = "granted"; const errors: unknown[] = [];
  const runtime = new PipelineRuntime({ backend: raw, getGraph: () => graph, setGraph: next => { graph = next; },
    publishMemory: async (asset, state, archive, guard) => {
      await options.beforeWrite?.(state); await storage.save({ graph: asset, pipeline: state, ...(archive ? {archive} : {}) }, guard);
      options.afterWrite?.(structuredClone(state), structuredClone(asset));
    },
    measureContext: async () => 1, getRoleInputBudget: () => 1000000, getRoleOutputBudget: () => 1000000,
    embed: async () => null, getModel: () => ({} as any), getBaseUrl: () => "invalid", getModelId: () => "fixture", getAuth: () => "not-persisted",
    getConsent: () => storage.invalidated ? "declined" : consent, addCost: () => {}, onStateChange: () => {}, onActivity: () => {},
    onError: error => { errors.push(error); }, runLoop: async (...args) => {
      const output = await (options.loop ?? (async () => completed()))(...args);
      const summaryDraft = args[1].tools!.find(tool => tool.name === "summary_draft");
      if (summaryDraft) await summaryDraft.execute("finish", { operation: "store", text: "The user maintains an orchard." }, undefined, undefined);
      else await args[1].tools!.find(tool => tool.name === "memory_finish")!.execute("finish", { outcome: "completed", reason: "Fixture completed" }, undefined, undefined);
      return output;
    }, completion: options.roleLoop ? undefined : args => async (...params) => { const text = await (options.summary ?? (() => async () => "[NO_ENTRY]"))(args)(...params); args.onUsage?.({promptTokens:1,completionTokens:1}); return text; },
  });
  runtime.loadSnapshot(saved); runtime.startSession("conversation");
  return { runtime, storage, raw, graph: () => graph, errors, revoke: () => { consent = "declined"; return runtime.cancel(); } };
}
async function add(context: any, label = "orchard") {
  await context.tools.find((t: any) => t.name === "add_term").execute("call", { label, description: "A cultivated fruit garden." }, undefined, undefined);
}

test("admission is durable; a failed draft and its action buffer never become visible", async () => {
  const entered = deferred(), release = deferred(); let calls = 0;
  const h = await fixture({ loop: async (_messages, context) => {
    if (calls++ === 0) { await add(context); entered.resolve(); await release.promise; throw new Error("interrupted provider"); }
    return completed();
  } });
  h.runtime.onTurnEnd(() => messages, false); await entered.promise;
  assert.equal(h.graph().thoughts.size, 0); assert.equal(h.runtime.activity.filter(a => a.agent === "audit").length, 0);
  const durable = await h.raw.get<PipelineSnapshot>("pipeline", "state");
  assert.equal(durable!.jobs![0].stages.audit, "running"); assert.equal(durable!.jobs![0].messages.length, 1);
  assert(!JSON.stringify(durable).includes("not-persisted"));
  release.resolve(); await h.runtime.whenIdle();
  assert.equal(h.graph().thoughts.size, 0); assert.equal(h.runtime.snapshot().buffers.audit.length, 0);
  assert.equal(h.runtime.snapshot().jobs![0].stages.audit, "failed");
  assert.equal(h.runtime.snapshot().jobs![0].stages.memory, "pending");
});

test("reload retries only unacknowledged stages, preserving summary and committed action exactly once", async () => {
  let calls = 0;
  const original = await fixture({ loop: async (_messages, context) => {
    if (calls++ === 0) await add(context);
    else throw new Error("interrupted memory stage");
    return completed();
  }, summary: () => async () => "A committed summary." });
  original.runtime.onTurnEnd(() => messages, false); await original.runtime.whenIdle();
  assert.equal(original.runtime.snapshot().jobs![0].stages.audit, "complete");
  let retries = 0;
  const resumed = await fixture({ raw: original.raw, loop: async (_messages, context) => { retries++; await add(context, "workshop"); return completed(); },
    summary: () => async () => "A committed summary." });
  resumed.runtime.resumePending(); await resumed.runtime.whenIdle();
  assert.equal(retries, 1); assert.equal(resumed.graph().thoughts.size, 2);
  assert.equal(resumed.runtime.snapshot().buffers.audit.length, 1);
  assert.equal(resumed.runtime.snapshot().buffers.memory.length, 1);
  assert.equal(resumed.runtime.getRunningContext()[0].text, "A committed summary.");
  assert.deepEqual(Object.values(resumed.runtime.snapshot().jobs![0].stages), ["complete", "complete", "complete"]);
  assert.deepEqual(resumed.runtime.snapshot().jobs![0].messages, []);
  const again = await fixture({ raw: original.raw, loop: async () => { throw new Error("acknowledged work replayed"); } });
  again.runtime.resumePending(); await again.runtime.whenIdle(); assert.equal(again.errors.length, 0);
});

test("summary and retrieval publication cannot overwrite a concurrent successful draft", async () => {
  const entered = deferred(), release = deferred(); let calls = 0;
  const seed = Graph.empty(); seed.getOrCreate("orchard", "A fruit garden.");
  const h = await fixture({ initialGraph: seed.serialize(), loop: async (_messages, context) => {
    if (calls++ === 0) { await add(context, "workshop"); entered.resolve(); await release.promise; }
    return completed();
  }, summary: () => async () => "Summary owned by the summary stage." });
  h.runtime.onTurnEnd(() => messages, false); await entered.promise;
  await h.runtime.updateRetrievalCounters(graph => graph.fire(graph.get("orchard")!));
  assert.equal(h.graph().get("orchard")!.hit_count, 1); assert.equal(h.graph().get("workshop"), null);
  release.resolve(); await h.runtime.whenIdle();
  assert.equal(h.graph().get("orchard")!.hit_count, 1); assert(h.graph().get("workshop"));
  assert.equal(h.runtime.getRunningContext()[0].text, "Summary owned by the summary stage.");
  const stored = await h.raw.get<GraphAsset>("lexicon", "terms");
  assert.equal(Object.values(stored!.thoughts).find(t => t.label === "orchard")!.hit_count, 1);
});

test("failed atomic publication retains old graph, owned fields and acknowledgement", async () => {
  let rejected = false; let calls = 0;
  const h = await fixture({ loop: async (_messages, context) => { if (calls++ === 0) await add(context); return completed(); },
    beforeWrite: async state => { if (!rejected && state.jobs?.[0].stages.audit === "complete") { rejected = true; throw new Error("quota exhausted"); } } });
  h.runtime.onTurnEnd(() => messages, false); await h.runtime.whenIdle();
  assert(rejected); assert.equal(h.graph().thoughts.size, 0); assert.equal(h.runtime.snapshot().buffers.audit.length, 0);
  assert.equal(h.runtime.snapshot().jobs![0].stages.audit, "failed");
  assert.equal(Object.keys((await h.raw.get<GraphAsset>("lexicon", "terms"))!.thoughts).length, 0);
});

test("revocation during a committing draft invalidates its exposure and clears durable recovery", async () => {
  const committing = deferred(), release = deferred(); let calls = 0; let held = false;
  const h = await fixture({ loop: async (_messages, context) => { if (calls++ === 0) await add(context); return completed(); },
    beforeWrite: async state => { if (!held && state.jobs?.[0].stages.audit === "complete") { held = true; committing.resolve(); await release.promise; } } });
  h.runtime.onTurnEnd(() => messages, false); await committing.promise;
  const stopped = h.revoke(); release.resolve(); await stopped; await h.runtime.whenIdle();
  assert.equal(h.graph().thoughts.size, 0); assert.deepEqual(h.runtime.snapshot().jobs, []);
  const saved = await h.raw.get<PipelineSnapshot>("pipeline", "state");
  assert.deepEqual(saved!.jobs, []); assert.equal(saved!.generation, 1);
  const reload = await fixture({ raw: h.raw, loop: async () => { throw new Error("revoked work replayed"); } });
  reload.runtime.resumePending(); await reload.runtime.whenIdle(); assert.equal(reload.errors.length, 0);
});

test("cross-tab consent revision conflict cannot expose draft or overwrite another writer", async () => {
  const entered = deferred(), release = deferred(); let calls = 0;
  const h = await fixture({ loop: async (_messages, context) => {
    if (calls++ === 0) { await add(context); entered.resolve(); await release.promise; }
    return completed();
  } });
  h.runtime.onTurnEnd(() => messages, false); await entered.promise;
  // Wait for the parallel summary publication before giving the other tab authority.
  await h.runtime.updateRetrievalCounters(() => undefined);
  const other = new MemoryStorage(h.raw); await other.load(); await other.save({ consent: "declined" });
  release.resolve(); await h.runtime.whenIdle();
  assert.equal(h.storage.invalidated, true); assert.equal(h.graph().thoughts.size, 0);
  assert.equal(await h.raw.get("memory-consent", "choice"), "declined");
});

test("an unfinished earlier turn blocks newer coverage until recovery, avoiding stale summary replacement", async () => {
  let calls = 0;
  const h = await fixture({ loop: async () => { calls++; throw new Error("provider unavailable"); } });
  h.runtime.onTurnEnd(() => messages, false); await h.runtime.whenIdle();
  h.runtime.onTurnEnd(() => messages, false); await h.runtime.whenIdle();
  assert.equal(calls, 1); assert.equal(h.runtime.snapshot().jobs!.length, 2);
  assert.equal(h.runtime.snapshot().jobs![1].stages.summary, "pending");
});

test("malformed coverage, mixed generations and duplicate turn identities fail closed", async () => {
  const h = await fixture(); const base = h.runtime.snapshot();
  const job = { id: "one", generation: 0, sessionKey: "session", messages: [], isVoiceTurn: false,
    stages: { audit: "pending", memory: "pending", summary: "pending" } };
  for (const jobs of [[{ ...job, generation: 1 }], [job, job], [{ ...job, stages: {} }], [{ ...job, messages: [null] }]]) {
    assert.throws(() => validatePipelineState({ ...base, jobs }));
  }
});

test("explicit retry processes older coverage before newer work and clears stalled state", async () => {
  let fail = true; const seen: string[] = [];
  const h = await fixture({ loop: async prompt => {
    const text = String((prompt[0] as any).content); seen.push(text.includes("older-turn") ? "old" : "new");
    if (fail) throw new Error("temporary failure"); return completed();
  } });
  h.runtime.onTurnEnd(() => [{ role: "user", content: "older-turn", timestamp: 1 }] as any, false);
  await h.runtime.whenIdle(); assert(h.runtime.hasFailedWork);
  h.runtime.onTurnEnd(() => messages, false); await h.runtime.whenIdle();
  assert.deepEqual(seen, ["old"]);
  fail = false; h.runtime.retryPending(); await h.runtime.whenIdle();
  assert.deepEqual(seen, ["old", "old", "old", "new", "new"]);
  assert.equal(h.runtime.hasFailedWork, false);
  assert(h.runtime.snapshot().jobs!.every(job => Object.values(job.stages).every(state => state === "complete")));
});

test("counter updater rejects structural and semantic writes without publication", async () => {
  const seed = Graph.empty(); seed.getOrCreate("orchard", "A fruit garden.");
  const h = await fixture({ initialGraph: seed.serialize() });
  await assert.rejects(h.runtime.updateRetrievalCounters(graph => graph.getOrCreate("workshop", "Tools.")), /counters only/);
  await assert.rejects(h.runtime.updateRetrievalCounters(graph => { graph.get("orchard")!.description = "Changed"; }), /counters only/);
  await assert.rejects(h.runtime.updateRetrievalCounters(graph => { graph.get("orchard")!.hit_count = -1; }), /counters only/);
  await assert.rejects(h.runtime.updateRetrievalCounters(graph => { graph.get("orchard")!.hit_count_tool = 1; }), /counters only/);
  assert.equal(h.graph().thoughts.size, 1); assert.equal(h.graph().get("orchard")!.description, "A fruit garden.");
  const escaped = await h.runtime.updateRetrievalCounters(graph => { graph.fire(graph.get("orchard")!); return graph.get("orchard")!; });
  escaped.description = "External reference cannot mutate installed state";
  assert.equal(h.graph().get("orchard")!.description, "A fruit garden.");
});

test("crash snapshots at every publication boundary recover only unacknowledged stage identities", async () => {
  const checkpoints: Array<{ state: PipelineSnapshot; graph: GraphAsset }> = [];
  const h = await fixture({ loop: async (_messages, context) => { await add(context); return completed(); },
    summary: () => async () => "A summary.", afterWrite: (state, graph) => checkpoints.push({ state, graph }) });
  h.runtime.onTurnEnd(() => messages, false); await h.runtime.whenIdle();
  assert(checkpoints.some(({ state }) => state.jobs?.[0].stages.audit === "running"));
  assert(checkpoints.some(({ state }) => state.jobs?.[0].stages.audit === "complete"));
  assert.equal(checkpoints.length, 7); // admission plus intent/commit for each of three stages
  for (const checkpoint of checkpoints) {
    const raw = backend(); const storage = new MemoryStorage(raw); await storage.load();
    await storage.save({ graph: checkpoint.graph, pipeline: checkpoint.state });
    let loops = 0, summaries = 0;
    const replay = await fixture({ raw, loop: async (_messages, context) => { loops++; await add(context); return completed(); },
      summary: () => async () => { summaries++; return "A summary."; } });
    replay.runtime.resumePending(); await replay.runtime.whenIdle();
    const prior = checkpoint.state.jobs![0].stages;
    assert.equal(loops, Number(prior.audit !== "complete") + Number(prior.memory !== "complete"));
    assert.equal(summaries, Number(prior.summary !== "complete"));
    assert.equal(replay.runtime.snapshot().buffers.audit.length, 1);
    assert.equal(replay.runtime.snapshot().buffers.memory.length, 1);
    assert.equal(replay.graph().thoughts.size, 1);
  }
});

test("draft merges carry concurrent retrieval counts into the surviving identity", async () => {
  const seed = Graph.empty(); seed.getOrCreate("orchard", "Fruit trees."); seed.getOrCreate("grove", "Fruit trees."); seed.getOrCreate("garden", "Fruit trees.");
  const entered = deferred(), release = deferred(); let calls = 0;
  const h = await fixture({ initialGraph: seed.serialize(), loop: async (_messages, context) => {
    if (calls++ === 0) {
      const merge = context.tools!.find(tool => tool.name === "merge_terms")!;
      await merge.execute("one", { loser: "orchard", survivor: "grove" }, undefined, undefined);
      await merge.execute("two", { loser: "grove", survivor: "garden" }, undefined, undefined);
      entered.resolve(); await release.promise;
    }
    return completed();
  } });
  h.runtime.onTurnEnd(() => messages, false); await entered.promise;
  await h.runtime.updateRetrievalCounters(graph => { graph.fire(graph.get("orchard")!); graph.fire(graph.get("grove")!); });
  release.resolve(); await h.runtime.whenIdle();
  assert.equal(h.graph().thoughts.size, 1); assert.equal(h.graph().get("garden")!.hit_count, 2);
  assert(h.graph().get("garden")!.last_fired);
});

test("glossary review drafts roll back with failed stages and publish receipts only on retry", async () => {
  const source=Graph.empty();const a=source.getOrCreate("orchard-planner","The fruit garden calendar.");const b=source.getOrCreate("orchard-planning","A second label for the fruit garden calendar.");
  let fail=true;
  const h=await fixture({initialGraph:source.serialize(),loop:async (_messages,context)=>{
    const review=context.tools!.find(tool=>tool.name==="maintenance_review");
    if(review){
      await review.execute("merge",{operation:"merged",ids:[a.id,b.id],survivor_id:a.id,reason:"Same calendar"},undefined,undefined);
      if(fail) throw new Error("interrupted after private merge");
    }
    return completed();
  }});
  h.runtime.onTurnEnd(()=>messages,false);await h.runtime.whenIdle();
  assert.equal(h.graph().thoughts.size,2);assert.equal(h.runtime.snapshot().maintenance!.decisions.length,0);
  assert.equal(h.runtime.snapshot().jobs![0].stages.memory,"failed");
  fail=false;h.runtime.retryPending();await h.runtime.whenIdle();
  assert.equal(h.graph().thoughts.size,1);assert.equal(h.runtime.snapshot().maintenance!.decisions[0].before.length,2);
  const durable=await h.raw.get<PipelineSnapshot>("pipeline","state");
  assert.equal(durable!.maintenance!.decisions[0].survivorId,a.id);
  assert.equal(durable!.jobs![0].stages.memory,"complete");
});

for (const failedRole of ["audit", "memory", "summary"] as const) {
  test(`persistent storage failure after ${failedRole} intent remains visible and retryable`, async () => {
    let unavailable = false;
    let inject = true;
    const h = await fixture({ roleLoop: true,
      loop: async (prompt, context) => {
        const text = String((prompt[0] as any).content);
        if (text.includes("## Your role: audit")) await add(context, "audit-term");
        else if (!text.includes("## Your role: summary")) await add(context, "memory-term");
        return completed();
      },
      beforeWrite: async state => {
        if (inject && state.jobs?.[0].stages[failedRole] === "complete") unavailable = true;
        if (unavailable) throw new Error("Synthetic storage unavailable");
      },
    });
    h.runtime.onTurnEnd(() => messages, false);
    await assert.doesNotReject(h.runtime.whenIdle());
    assert(h.errors.length > 0, "storage failure must reach the application error surface");
    assert(h.runtime.hasFailedWork, "idle indicator must expose failed publication instead of showing saved");
    const durable = await h.raw.get<PipelineSnapshot>("pipeline", "state");
    assert.equal(durable!.jobs![0].stages[failedRole], "running", "failed receipt must not invent durable acknowledgement");
    assert.equal(durable!.jobs![0].messages.length, 1, "unfinished source must remain recoverable");
    const prior = ["audit", "memory", "summary"].indexOf(failedRole);
    assert.equal(h.graph().thoughts.size, Math.min(prior, 2), "failed graph draft must stay private");
    assert.equal(h.runtime.getRunningContext().length, 0);
    inject = false; unavailable = false;
    h.runtime.retryPending(); await h.runtime.whenIdle();
    assert.equal(h.runtime.hasFailedWork, false);
    assert.deepEqual(Object.values(h.runtime.snapshot().jobs![0].stages), ["complete", "complete", "complete"]);
  });
}


for (const failedRole of ["audit", "memory", "summary"] as const) {
  test(`provider failure in ${failedRole} rolls back that role and retry does not replay siblings`, async () => {
    let fail = true;
    const calls: string[] = [];
    const h = await fixture({ roleLoop: true, loop: async (prompt, context) => {
      const text = String((prompt[0] as any).content);
      const role = text.includes("## Your role: audit") ? "audit" : text.includes("## Your role: summary") ? "summary" : "memory";
      calls.push(role);
      if (role !== "summary") await add(context, `${role}-term`);
      if (role === failedRole && fail) throw new Error("Synthetic provider disconnect after draft mutation");
      return completed();
    } });
    h.runtime.onTurnEnd(() => messages, false); await h.runtime.whenIdle();
    const roles = ["audit", "memory", "summary"] as const;
    const index = roles.indexOf(failedRole);
    assert.deepEqual(calls, roles.slice(0, index + 1));
    assert.equal(h.runtime.snapshot().jobs![0].stages[failedRole], "failed");
    assert.equal(h.graph().thoughts.size, Math.min(index, 2));
    assert.equal(h.runtime.getRunningContext().length, 0);
    const committedBefore = await h.raw.get<PipelineSnapshot>("pipeline", "state");
    assert.equal(committedBefore!.jobs![0].stages[failedRole], "failed");
    fail = false; h.runtime.retryPending(); await h.runtime.whenIdle();
    assert.deepEqual(calls, [...roles.slice(0, index + 1), ...roles.slice(index)]);
    assert.deepEqual(Object.values(h.runtime.snapshot().jobs![0].stages), ["complete", "complete", "complete"]);
    assert.equal(h.graph().thoughts.size, 2);
    assert.equal(h.runtime.getRunningContext()[0].text, "The user maintains an orchard.");
  });
}
