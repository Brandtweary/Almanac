import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import type { Graph } from "./kg/graph.js";
import type { Thought } from "./kg/types.js";
import { validVector } from "./kg/types.js";
import { jaroWinkler, cosineSimilarity } from "./kg/similarity.js";

export const MAINTENANCE_INSTRUCTIONS = "Personal glossary maintenance: call maintenance_review(list), inspect pending pairs, and adjudicate only supported equivalence or distinction. Defer uncertain pairs; unfinished review remains queued. Prior decisions are readable with maintenance_review(decisions) and bind until explicit user reconsideration. Same-stage ingestion changes are visible; stale pairs reject adjudication. This work concerns personal terms, never corpus documents. Dedicated maintenance_review candidates may be adjudicated on their first review after inspecting both current definitions and relevant evidence; similarity alone never establishes identity. This is a narrow exception to the recurrence safeguard for conversational merge_terms, which still requires separate-turn evidence. Defer uncertainty with a reason; permanent distinct decisions remain binding.";

const compareIds = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;

export interface MaintenancePair { ids: [string, string]; fingerprints: [string, string]; deferredReason?: string }
export interface MaintenanceDecision extends MaintenancePair {
  verdict: "distinct" | "merged"; reason: string; ts: string; before: [Thought, Thought]; survivorId?: string; forgottenAt?: string;
}
export interface MaintenanceState {
  version: 1; seen: Record<string, string>; work: Array<{ id: string; after: string }>;
  rotation: string; pending: MaintenancePair[]; decisions: MaintenanceDecision[];
}
export const emptyMaintenance = (): MaintenanceState => ({ version: 1, seen: {}, work: [], rotation: "", pending: [], decisions: [] });
// Exact canonical content is a collision-free fingerprint; usage and vector metadata are excluded.
export const termFingerprint = (term: Thought): string => JSON.stringify([term.label, term.description, [...term.aliases].sort()]);
const pairOf = (a: Thought, b: Thought): MaintenancePair => {
  const terms = [a,b].sort((x,y) => compareIds(x.id,y.id));
  return { ids: terms.map(t => t.id) as [string,string], fingerprints: terms.map(termFingerprint) as [string,string] };
};
const samePair = (a: MaintenancePair,b: MaintenancePair) => JSON.stringify(a.ids) === JSON.stringify(b.ids) && JSON.stringify(a.fingerprints) === JSON.stringify(b.fingerprints);
const livePair = (graph: Graph,pair: MaintenancePair) => pair.ids.every((id,i) => {
  const term = graph.thoughts.get(id); return term && termFingerprint(term) === pair.fingerprints[i];
});

/** Bounded deterministic scan; all mutations belong to the caller's unpublished stage. */
export function prepareMaintenance(graph: Graph, state: MaintenanceState, budget = 128): void {
  const terms = [...graph.thoughts.values()].sort((a,b) => compareIds(a.id,b.id));
  state.pending = state.pending.filter(pair => livePair(graph,pair));
  state.work = state.work.filter(row => graph.thoughts.has(row.id));
  for (const term of terms) {
    const fingerprint = termFingerprint(term);
    if (state.seen[term.id] !== fingerprint) {
      Object.defineProperty(state.seen, term.id, { value: fingerprint, writable: true, configurable: true, enumerable: true });
      const work = state.work.find(row => row.id === term.id);
      if (work) work.after = ""; else state.work.push({id:term.id,after:""});
    }
  }
  const rotating = terms.find(term => compareIds(term.id,state.rotation) > 0) ?? terms[0];
  if (rotating) {
    state.rotation = rotating.id;
    if (!state.work.some(row => row.id === rotating.id)) state.work.push({id:rotating.id,after:""});
  }
  while (budget > 0 && state.work.length && state.pending.length < 32) {
    const work = state.work[0]; const a = graph.thoughts.get(work.id)!;
    const b = terms.find(term => compareIds(term.id,work.after) > 0);
    if (!b) { state.work.shift(); continue; }
    work.after = b.id; budget--;
    if (a.id === b.id || !a.description || !b.description) continue;
    const pair = pairOf(a,b);
    if (state.pending.some(row => samePair(row,pair)) || state.decisions.some(row => !row.forgottenAt && JSON.stringify(row.ids) === JSON.stringify(pair.ids))) continue;
    const lexical = [a.label,...a.aliases].some(x => [b.label,...b.aliases].some(y => jaroWinkler(x.toLowerCase(),y.toLowerCase()) >= .87));
    const semantic = !!a.embedding_encoder && a.embedding_encoder === b.embedding_encoder && validVector(a.embedding) && validVector(b.embedding) && a.embedding.length === b.embedding.length && cosineSimilarity(a.embedding,b.embedding) >= .6;
    if (lexical || semantic) state.pending.push(pair);
  }
}

/** Explicit user review only; models have no tool granting this authority. */
export function forgetMaintenanceDecision(state: MaintenanceState, ids: [string,string]): void {
  if (ids[0] === ids[1]) throw new Error("Review requires two distinct identities");
  const matches = state.decisions.filter(row => ids.every(id => row.ids.includes(id)) && !row.forgottenAt);
  if (!matches.length) throw new Error("No binding decision for this pair");
  for (const row of matches) row.forgottenAt = new Date().toISOString();
  for (const id of ids) if (!state.work.some(row => row.id === id)) state.work.push({id,after:""});
}

export function assertMaintenanceMergeAllowed(state: MaintenanceState, a: string, b: string): void {
  if (state.decisions.some(row => !row.forgottenAt && row.verdict === "distinct" && row.ids.includes(a) && row.ids.includes(b))) throw new Error("This pair has a binding distinct decision; only explicit user reconsideration can reopen it");
}

export function recordMerge(state: MaintenanceState, loser: Thought, survivor: Thought, reason: string): void {
  const pair = pairOf(loser,survivor);
  state.decisions.push({...pair,verdict:"merged",reason,ts:new Date().toISOString(),before: structuredClone(pair.ids[0] === loser.id ? [loser,survivor] : [survivor,loser]),survivorId:survivor.id});
  state.pending = state.pending.filter(row => !row.ids.includes(loser.id));
}

export function createMaintenanceTool(deps: { graph: Graph; state: MaintenanceState; assertActive: () => void; record: (line:string) => void; onMerge: (loser:string,survivor:string) => void }): AgentTool<any> {
  const {graph,state} = deps;
  return { name:"maintenance_review",label:"Review personal glossary",description:"List pending duplicate candidates (four per page), inspect prior decisions, defer an unresolved pair, or adjudicate distinct/merged with a reason. Similarity is only a hint. Inspect both complete descriptions first. Merge requires survivor_id; original descriptions are retained. This dedicated review can adjudicate a pair on its first review from both current definitions/evidence; conversational merge_terms still requires recurrence. Deferral requires a reason. Decisions and coverage publish with this memory stage only.",
    parameters:Type.Object({operation:Type.Union([Type.Literal("list"),Type.Literal("decisions"),Type.Literal("defer"),Type.Literal("distinct"),Type.Literal("merged")]),offset:Type.Optional(Type.Integer({minimum:0})),ids:Type.Optional(Type.Array(Type.String(),{minItems:2,maxItems:2})),survivor_id:Type.Optional(Type.String()),reason:Type.Optional(Type.String())}),
    execute:async (_id,raw) => {
      deps.assertActive(); const p = raw as {operation:string;offset?:number;ids?:string[];survivor_id?:string;reason?:string};
      const text = (value:unknown) => ({content:[{type:"text" as const,text:JSON.stringify(value)}],details:{}});
      if (p.operation === "list" || p.operation === "decisions") {
        const rows = p.operation === "list" ? state.pending.filter(pair => livePair(graph,pair)) : state.decisions;
        const filtered = p.ids ? rows.filter(row => p.ids!.every(id => row.ids.includes(id))) : rows;
        const offset = p.offset ?? 0;
        return text({total:filtered.length,next:offset+4 < filtered.length ? offset+4 : null,rows:filtered.slice(offset,offset+4).map(row => ({...row,terms:row.ids.map(id => {const t=graph.thoughts.get(id);return t ? {id,label:t.label,description:t.description} : {id,removed:true};})}))});
      }
      const pair = state.pending.find(row => p.ids?.length === 2 && row.ids.every(id => p.ids!.includes(id)));
      if (!pair || !livePair(graph,pair)) throw new Error("Candidate missing or changed; list live candidates before adjudicating");
      if (p.operation === "defer") {
        if (!p.reason?.trim()) throw new Error("Deferral requires a reason");
        pair.deferredReason=p.reason; state.pending=state.pending.filter(row => row!==pair);state.pending.push(pair);
        deps.record(`deferred glossary pair: ${pair.ids.join(" / ")}: ${p.reason}`);
        return text({deferred:true,reason:p.reason});
      }
      if (!p.reason?.trim()) throw new Error("Adjudication requires a reason");
      const before = pair.ids.map(id => structuredClone(graph.thoughts.get(id)!)) as [Thought,Thought];
      if (p.operation === "merged") {
        const survivor = before.find(t => t.id === p.survivor_id); const loser=before.find(t => t.id !== p.survivor_id);
        assertMaintenanceMergeAllowed(state,before[0].id,before[1].id);
        if (!survivor || !loser || !graph.merge(loser.label,survivor.label)) throw new Error("Merge refused; choose a live candidate survivor");
        recordMerge(state,loser,survivor,p.reason);deps.onMerge(loser.id,survivor.id);
      } else if (p.operation === "distinct") {
        state.decisions.push({...pair,verdict:"distinct",reason:p.reason,ts:new Date().toISOString(),before});
        state.pending=state.pending.filter(row => row!==pair);
      } else throw new Error("Unknown maintenance operation");
      deps.record(`glossary pair ${p.operation}: ${before.map(t=>t.label).join(" / ")}`);
      return text({recorded:p.operation});
    }};
}

export function validateMaintenance(value: unknown): asserts value is MaintenanceState {
  const s = value as MaintenanceState;
  const pair = (p:MaintenancePair) => p && Array.isArray(p.ids) && p.ids.length===2 && p.ids.every(id=>typeof id==="string" && !!id) && compareIds(p.ids[0],p.ids[1]) < 0 && Array.isArray(p.fingerprints) && p.fingerprints.length===2 && p.fingerprints.every(f=>typeof f==="string") && (p.deferredReason===undefined || typeof p.deferredReason==="string");
  if (!s || s.version!==1 || typeof s.rotation!=="string" || !s.seen || typeof s.seen!=="object" || Array.isArray(s.seen) || Object.values(s.seen).some(f=>typeof f!=="string") || !Array.isArray(s.work) || s.work.some(w=>!w || typeof w.id!=="string" || typeof w.after!=="string") || !Array.isArray(s.pending) || s.pending.some(p=>!pair(p)) || !Array.isArray(s.decisions) || s.decisions.some(d=>!pair(d) || !["distinct","merged"].includes(d.verdict) || typeof d.reason!=="string" || !d.reason.trim() || typeof d.ts!=="string" || (d.forgottenAt !== undefined && typeof d.forgottenAt !== "string") || !Array.isArray(d.before) || d.before.length!==2 || d.before.some((t,i)=>!t || t.id!==d.ids[i] || typeof t.label!=="string" || !(typeof t.description==="string" || t.description===null) || !Array.isArray(t.aliases) || t.aliases.some(a=>typeof a!=="string") || termFingerprint(t)!==d.fingerprints[i]) || (d.verdict==="merged" && !d.ids.includes(d.survivorId!)))) throw new Error("Invalid personal glossary review state");
}
