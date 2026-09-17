import assert from "node:assert/strict";
import { test } from "node:test";
import { Graph } from "../src/kg/graph.js";
import { RecallPool, StaleRecallError, renderRecall } from "../src/kg/recall-pool.js";

const policy = { messageTerms: 8, toolTerms: 4, reinforcementBase: 2 };
const measure = async (block: string | null) => 10 + (block?.length ?? 0);
const setup = () => {
  const graph = Graph.empty();
  graph.getOrCreate("orchard", "Trees grown for fruit.");
  graph.getOrCreate("cistern", "A store of collected water.");
  return { graph, pool: new RecallPool(policy) };
};

test("tool observations do not age user recall; both sources deduplicate with attributed hits", async () => {
  const { graph, pool } = setup();
  const user = pool.observe("message", "orchard", graph);
  for (let i = 0; i < 25; i++) pool.observe("tool", "cistern", graph);
  const tool = pool.observe("tool", "orchard", graph);
  const result = await pool.prepare(graph, measure, 10000);
  assert.equal(result.terms.filter(t => t.label === "orchard").length, 1);
  assert.deepEqual(result.terms.find(t => t.label === "orchard")!.sources, ["message", "tool"]);
  assert.deepEqual(user, [{ id: graph.get("orchard")!.id, source: "message" }]);
  assert.deepEqual(tool, [{ id: graph.get("orchard")!.id, source: "tool" }]);
  assert.equal(graph.get("orchard")!.hit_count, 0, "caller owns durable counter writes");
});

test("expiry permits reentry; repeat observations reinforce only their own clock", async () => {
  const { graph, pool } = setup();
  pool.observe("message", "orchard", graph);
  pool.observe("message", "no match", graph);
  assert.equal((await pool.prepare(graph, measure, 10000)).terms.length, 0);
  pool.observe("message", "orchard", graph);
  pool.observe("message", "orchard", graph);
  pool.observe("message", "no match", graph);
  assert.equal((await pool.prepare(graph, measure, 10000)).terms[0].label, "orchard");
  for (let i = 0; i < 3; i++) pool.observe("message", "no match", graph);
  assert.equal((await pool.prepare(graph, measure, 10000)).terms.length, 0);
  pool.observe("message", "orchard", graph);
  assert.equal((await pool.prepare(graph, measure, 10000)).terms[0].label, "orchard");
});

test("request snapshots reread renamed/updated definitions and omit removed terms", async () => {
  const { graph, pool } = setup();
  pool.observe("message", "orchard cistern", graph);
  graph.getOrCreate("orchard", "Fruit trees with a revised definition.");
  graph.rename("orchard", "fruit-garden");
  graph.remove("cistern");
  const result = await pool.prepare(graph, measure, 10000);
  assert.equal(result.terms.length, 1);
  assert.equal(result.terms[0].label, "fruit-garden");
  assert.match(result.terms[0].description, /revised/);
  assert.equal(result.terms[0].matches[0].surface, "orchard", "historical match provenance survives rename");
});

test("exact request budgeting preserves whole definitions and retains overflow for later", async () => {
  const { graph, pool } = setup();
  pool.observe("message", "orchard", graph);
  const full = await pool.prepare(graph, measure, 10000);
  const tokens = await measure(renderRecall(full.terms));
  const omitted = await pool.prepare(graph, measure, tokens - 1);
  assert.equal(omitted.block, null);
  assert.deepEqual(omitted.omittedIds, [graph.get("orchard")!.id]);
  assert.equal((await pool.prepare(graph, measure, tokens)).terms[0].description, full.terms[0].description);
  await assert.rejects(pool.prepare(graph, measure, 9), /Base request exceeds/);
  await assert.rejects(pool.prepare(graph, async () => NaN, 100), /Invalid request-token/);
});

test("racing reset, observation and definition changes invalidate async preparation", async () => {
  for (const mutation of ["reset", "observe", "definition"] as const) {
    const { graph, pool } = setup();
    pool.observe("message", "orchard", graph);
    let changed = false;
    await assert.rejects(pool.prepare(graph, async block => {
      if (!changed) {
        changed = true;
        if (mutation === "reset") pool.reset();
        if (mutation === "observe") pool.observe("tool", "cistern", graph);
        if (mutation === "definition") graph.getOrCreate("orchard", "Changed while measuring.");
      }
      return measure(block);
    }, 10000), StaleRecallError);
  }
});

test("only admitted snapshots produce immutable, request-idempotent audit evidence", async () => {
  const { graph, pool } = setup();
  pool.observe("message", "orchard", graph);
  const prepared = await pool.prepare(graph, measure, 10000);
  assert.deepEqual(pool.drainDeliveries(), []);
  prepared.terms[0].description = "caller tampering";
  const receipt = pool.commitDelivery(prepared, "request-1");
  assert.equal(receipt.terms[0].description, "Trees grown for fruit.");
  pool.commitDelivery(prepared, "request-1");
  assert.equal(pool.drainDeliveries().length, 1);
  assert.equal(pool.drainDeliveries().length, 0);
  graph.getOrCreate("orchard", "Updated after an admitted request.");
  const different = await pool.prepare(graph, measure, 10000);
  assert.throws(() => pool.commitDelivery(different, "request-1"), /already belongs/);
  pool.reset();
  assert.throws(() => pool.commitDelivery(prepared, "request-2"), StaleRecallError);
  assert.equal((await pool.prepare(graph, measure, 10000)).terms.length, 0);
});

test("source capacities bound working sets without sharing eviction budgets", async () => {
  const { graph } = setup();
  const pool = new RecallPool({ ...policy, messageTerms: 1, toolTerms: 0 });
  pool.observe("message", "orchard", graph);
  pool.observe("tool", "cistern", graph);
  assert.deepEqual((await pool.prepare(graph, measure, 10000)).terms.map(t => t.label), ["orchard"]);
  assert.throws(() => new RecallPool({ ...policy, toolTerms: -1 }), /capacities/);
});
