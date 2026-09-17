import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";

export interface EvidenceQuote { recordId: string; quote: string; role: string }
export type AuditFinding = { kind: "spelling"; transcribed: string; spoken: string; utteranceId: string; evidence: EvidenceQuote[] } |
  { kind: "stale-description"; termId: string; reason: string; evidence: EvidenceQuote[] };
export type StageOutcome = { kind: "completed" | "no-op" | "refused" | "failed" | "transient" | "cancelled" | "budget-exhausted"; reason?: string };
export class MemoryRefusalError extends Error {}
export class MemoryBudgetError extends Error {}
export class MemoryTransientError extends Error {}
const result = (text: string) => ({ content: [{ type: "text" as const, text }], details: {} });

export function createStageOutcomeTool(deps: { finish: (outcome: "completed" | "no-op" | "refused", reason: string) => void }): AgentTool<any> {
  return { name: "memory_finish", label: "Record memory outcome", description: "Record completed work, deliberate no-op or refusal explicitly. No-op cannot hide draft changes. Refusal leaves coverage outstanding. Summary success uses summary_draft store/abstain instead.",
    parameters: Type.Object({ outcome: Type.Union([Type.Literal("completed"), Type.Literal("no-op"), Type.Literal("refused")]), reason: Type.String({ minLength: 1 }) }),
    execute: async (_id, raw) => { const p = raw as { outcome: "completed" | "no-op" | "refused"; reason: string }; deps.finish(p.outcome, p.reason); return result("Outcome recorded for this private evidence window."); } };
}

export function createSummaryDraftTool(deps: { read: () => string; store: (text: string) => void; abstain: (reason: string) => void; maxWords: number }): AgentTool<any> {
  return { name: "summary_draft", label: "Work on summary draft",
    description: "Read, check, or store the complete revised conversation summary in this private stage; abstain deliberately with a reason to preserve the prior entry. Check and store enforce identical limits and return errors while you can repair the draft. Terminal prose is never stored. Each evidence window requires store or abstain.",
    parameters: Type.Object({ operation: Type.Union([Type.Literal("read"), Type.Literal("check"), Type.Literal("store"), Type.Literal("abstain")]), text: Type.Optional(Type.String()), reason: Type.Optional(Type.String()) }),
    execute: async (_id, raw) => {
      const p = raw as { operation: string; text?: string; reason?: string };
      if (p.operation === "read") return result(deps.read());
      if (p.operation === "abstain") { if (!p.reason?.trim()) throw new Error("Abstention requires a reason"); deps.abstain(p.reason); return result("No-op recorded; previous summary draft retained."); }
      if (p.operation !== "check" && p.operation !== "store") throw new Error("Unknown summary operation");
      const text = p.text?.trim() ?? ""; const words = text ? text.split(/\s+/).length : 0;
      if (!words || words > deps.maxWords) throw new Error(`Summary has ${words} words; supply 1–${deps.maxWords} words and retry`);
      if (p.operation === "store") deps.store(text);
      return result(JSON.stringify({ valid: true, words, stored: p.operation === "store" }));
    } };
}

export function createAuditHandoffTool(deps: { put: (finding: Omit<Extract<AuditFinding, {kind:"spelling"}>, "evidence"> | Omit<Extract<AuditFinding, {kind:"stale-description"}>, "evidence">, evidence: Array<{recordId:string;quote:string}>) => void }): AgentTool<any> {
  return { name: "audit_handoff", label: "Publish scoped audit evidence",
    description: "Add supported spelling or stale-description evidence to this audit's private handoff. Cite exact quotations from admitted user records. For kind=spelling, supply transcribed, spoken and utteranceId matching accepted current-utterance STT evidence. For kind=stale-description, supply termId identifying an existing term and a nonempty reason explaining what is stale. Memory receives both kinds; summary receives only spelling. Findings publish only with successful audit coverage.",
    parameters: Type.Object({ kind: Type.Union([Type.Literal("spelling"), Type.Literal("stale-description")]), transcribed: Type.Optional(Type.String()), spoken: Type.Optional(Type.String()), utteranceId: Type.Optional(Type.String()), termId: Type.Optional(Type.String()), reason: Type.Optional(Type.String()), evidence: Type.Array(Type.Object({recordId:Type.String(),quote:Type.String({minLength:1})}), {minItems:1}) }),
    execute: async (_id, raw) => {
      const { evidence, ...finding } = raw as any;
      const present = (value: unknown) => typeof value === "string" && value.trim().length > 0;
      if (finding.kind === "spelling") {
        if (![finding.transcribed, finding.spoken, finding.utteranceId].every(present)) throw new Error("Spelling handoff requires transcribed, spoken and utteranceId");
      } else if (finding.kind !== "stale-description" || !present(finding.termId) || !present(finding.reason)) {
        throw new Error("Stale-description handoff requires an existing term and reason");
      }
      deps.put(finding, evidence); return result("Scoped finding added to the private audit handoff.");
    } };
}

/** Shared by production and qualification; summary has no glossary mutation authority. */
export function assembleMemoryRoleTools(role: "audit" | "memory" | "summary", tools: { mutationTools: AgentTool<any>[]; inspector: AgentTool<any>; finish: AgentTool<any>; summaryDraft: AgentTool<any>; auditHandoff: AgentTool<any>; archive?: AgentTool<any> }): AgentTool<any>[] {
  return [...(role === "summary" ? [] : tools.mutationTools), tools.inspector, tools.finish, ...(tools.archive ? [tools.archive] : []),
    ...(role === "summary" ? [tools.summaryDraft] : role === "audit" ? [tools.auditHandoff] : [])];
}
export function validateMemoryWindowOutcome(outcome: StageOutcome | undefined, stopReason: string | undefined): StageOutcome {
  if (outcome?.kind === "refused") throw new MemoryRefusalError(outcome.reason ?? "Role refused");
  if (stopReason === "length") throw new MemoryBudgetError("Completion exhausted its output budget before finishing");
  if (stopReason === "aborted") throw new MemoryTransientError("Completion was interrupted before finishing");
  if (!outcome) throw new Error("Memory window ended without an explicit outcome");
  if (stopReason !== "stop") throw new Error("Memory window did not complete successfully");
  return outcome;
}

export function createRoleArchiveTool(deps: { read: (cursor?: string, kind?: "actions" | "summary" | "outcome") => Promise<unknown> }): AgentTool<any> {
  return { name: "memory_archive", label: "Inspect retained role history", description: "Page this role's retained action, summary and outcome receipts across conversations. Results identify status and expose stage-local read handles for full records. Failed/transient records are diagnostic traces, never completed evidence. Empty filtered pages may still have a continuation cursor. Other roles are inaccessible; audit findings use scoped handoffs instead.",
    parameters: Type.Object({ cursor: Type.Optional(Type.String()), kind: Type.Optional(Type.Union([Type.Literal("actions"),Type.Literal("summary"),Type.Literal("outcome")])) }),
    execute: async (_id, raw) => { const args = raw as {cursor?:string;kind?:"actions"|"summary"|"outcome"}; return result(JSON.stringify(await deps.read(args.cursor,args.kind))); } };
}
