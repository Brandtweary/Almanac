import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { Graph } from "./kg/graph.js";
import { RecallPool, StaleRecallError, type RecallPolicy, type RecallDelivery, type RecallSource } from "./kg/recall-pool.js";

type Context = Parameters<StreamFn>[1];
/** Browser ownership adapter; all durable writes use the existing memory transaction. */
export class RecallSession {
  readonly pool: RecallPool;
  constructor(private deps: {
    policy: RecallPolicy; active: () => boolean; graph: () => Graph;
    updateCounters: <T>(operation: (graph: Graph) => T) => Promise<T>;
    onDelivery: (receipt: RecallDelivery) => void;
  }) { this.pool = new RecallPool(deps.policy); }
  reset(): void { this.pool.reset(); }
  async observe(source: RecallSource, text: string): Promise<void> {
    if (!this.deps.active()) return;
    try {
      await this.deps.updateCounters(graph => {
        if (!this.deps.active()) throw new Error("Personal recall authority expired");
        for (const hit of this.pool.observe(source, text, graph)) {
          const node = graph.thoughts.get(hit.id);
          if (node) graph.fire(node, hit.source);
        }
      });
    } catch (error) { this.reset(); throw error; }
  }
  async prepare(context: Context, measure: (context: Context) => Promise<number>, inputBudget: number) {
    if (!this.deps.active()) return { context, admitted: (_id: string) => {} };
    const timestamp = Date.now();
    const withBlock = (block: string | null): Context => block ? { ...context, messages: [...context.messages, { role: "user", content: block, timestamp }] } : context;
    const graph = this.deps.graph();
    const prepared = await this.pool.prepare(graph, block => measure(withBlock(block)), inputBudget);
    if (graph !== this.deps.graph()) throw new StaleRecallError();
    if (!this.deps.active()) throw new Error("Personal recall authority expired");
    return { context: withBlock(prepared.block), admitted: (requestId: string) => {
      if (!this.deps.active()) return;
      this.pool.commitDelivery(prepared, requestId);
      for (const receipt of this.pool.drainDeliveries()) this.deps.onDelivery(receipt);
    } };
  }
}
