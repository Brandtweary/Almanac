import { validateMaintenance } from "./glossary-maintenance.js";
import { assertMessageContent, validConversationMessage } from "./message-validation.js";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { SttLexicon } from "./stt-lexicon.js";

function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }
const strings = (value: Record<string, unknown>, keys: string[]) => keys.every((key) => typeof value[key] === "string");

/** Reject malformed imports before changing live state; optional evidence survives round trips. */
export function validateSttLexicon(value: unknown): asserts value is SttLexicon {
  if (!record(value) || !Array.isArray(value.autoReplace) || !Array.isArray(value.mistranscriptions)) throw new Error("Invalid speech memory");
  for (const row of value.autoReplace) {
    if (!record(row) || !strings(row, ["from", "to", "ts"]) || !(row.from as string).trim() || !(row.to as string).trim() || (row.exactCase !== undefined && typeof row.exactCase !== "boolean")) throw new Error("Invalid speech replacement rule");
  }
  for (const row of value.mistranscriptions) {
    if (!record(row) || !strings(row, ["spoken", "transcribed", "ts"]) ||
      !["phonetic", "semantic", "persistent_near_miss"].includes(row.kind as string) ||
      ["notes", "utteranceId", "rawText"].some((key) => row[key] !== undefined && typeof row[key] !== "string") ||
      (row.status !== undefined && !["accepted", "rejected"].includes(row.status as string))) throw new Error("Invalid speech evidence");
  }
}

export function validateRunningContext(value: unknown): asserts value is Array<{ sessionKey: string; ts: string; text: string }> {
  if (!Array.isArray(value) || value.some((row) => !record(row) || !strings(row, ["sessionKey", "ts", "text"]))) throw new Error("Invalid running context");
  if (new Set(value.map((row) => row.sessionKey)).size !== value.length) throw new Error("Duplicate conversation summary key");
}

export function validatePipelineState(value: unknown): void {
  if (!record(value) || !record(value.buffers) || !Array.isArray(value.flags)) throw new Error("Invalid memory pipeline state");
  if (value.maintenance !== undefined) validateMaintenance(value.maintenance);
  validateSttLexicon(value.sttLexicon); validateRunningContext(value.runningContext);
  for (const agent of ["audit", "memory", "summary"]) {
    const entries = value.buffers[agent];
    if (!Array.isArray(entries) || entries.some((row) => !record(row) || !strings(row, ["ts", "note"]) ||
      !Array.isArray(row.actions) || row.actions.some((action) => typeof action !== "string"))) throw new Error("Invalid memory action buffer");
  }
  for (const flag of value.flags) {
    if (!record(flag) || !strings(flag, ["kind", "description", "ts"]) || (flag.label !== undefined && typeof flag.label !== "string")) throw new Error("Invalid memory review flag");
  }
  if (value.generation !== undefined && (!Number.isSafeInteger(value.generation) || (value.generation as number) < 0)) throw new Error("Invalid memory generation");
  if (value.historyCoverage !== undefined) {
    if (!record(value.historyCoverage)) throw new Error("Invalid memory history coverage");
    for (const [session, ref] of Object.entries(value.historyCoverage)) {
      if (!record(ref) || !strings(ref,["sessionKey","firstId","lastId","digest"]) || ref.sessionKey !== session || !ref.firstId || !ref.lastId ||
        !Number.isSafeInteger(ref.count) || (ref.count as number) < 1 || !Number.isSafeInteger(ref.revision) || (ref.revision as number) < 0 || !/^[a-f0-9]{64}$/.test(ref.digest as string)) throw new Error("Invalid memory history coverage reference");
    }
  }
  if (value.jobs !== undefined) {
    if (!Array.isArray(value.jobs)) throw new Error("Invalid memory coverage");
    const ids = new Set<string>();
    for (const job of value.jobs) {
      if (!record(job) || !strings(job, ["id", "sessionKey"]) || !job.id || ids.has(job.id as string) ||
        !Number.isSafeInteger(job.generation) || job.generation !== (value.generation ?? 0) || typeof job.isVoiceTurn !== "boolean" ||
        !Array.isArray(job.messages) || job.messages.some(m => !record(m) || typeof m.role !== "string") || !record(job.stages) || Object.keys(job.stages).length !== 3 ||
        ["audit", "memory", "summary"].some(name => !["pending", "running", "complete", "failed", "refused"].includes((job.stages as Record<string, unknown>)[name] as string))) throw new Error("Invalid memory coverage job");
      if (job.history !== undefined) {
        const h = job.history;
        if (!record(h) || !strings(h, ["sessionKey", "firstId", "lastId", "digest"]) || h.sessionKey !== job.sessionKey ||
          !h.firstId || !h.lastId || !Number.isSafeInteger(h.revision) || (h.revision as number) < 0 ||
          !Number.isSafeInteger(h.count) || (h.count as number) < 1 || h.count !== job.inputCount || h.digest !== job.inputDigest || job.messages.length !== 0) throw new Error("Invalid archived memory range");
      }
      if (Array.from(job.messages).some(message => !validConversationMessage(message))) throw new Error("Invalid memory coverage message content");
      if (job.outcomes !== undefined) {
        if (!record(job.outcomes)) throw new Error("Invalid stage outcomes");
        for (const [role, outcome] of Object.entries(job.outcomes)) {
          if (!["audit", "memory", "summary"].includes(role) || !record(outcome) ||
            !["completed", "no-op", "refused", "failed", "transient", "cancelled", "budget-exhausted"].includes(outcome.kind as string) ||
            (outcome.reason !== undefined && typeof outcome.reason !== "string") ||
            ((job.stages as Record<string,unknown>)[role] === "complete" && !["completed", "no-op"].includes(outcome.kind as string))) throw new Error("Invalid stage outcome");
        }
      }
      if (job.handoffs !== undefined) {
        if (!Array.isArray(job.handoffs) || (job.stages as Record<string,unknown>).audit !== "complete") throw new Error("Unacknowledged audit handoff");
        for (const finding of job.handoffs) {
          if (!record(finding) || !Array.isArray(finding.evidence) || !finding.evidence.length || finding.evidence.some(ref => !record(ref) || !strings(ref,["recordId","quote"]) || !ref.quote || ref.role !== "user")) throw new Error("Invalid handoff evidence");
          if (finding.kind === "spelling" ? !strings(finding,["transcribed","spoken","utteranceId"]) : finding.kind !== "stale-description" || !strings(finding,["termId","reason"])) throw new Error("Invalid audit finding");
        }
      }
      if ([job.inputCount, job.inputDigest, job.coverageStart].some(field => field !== undefined)) {
        if (!Number.isSafeInteger(job.inputCount) || (job.inputCount as number) < 0 ||
          typeof job.inputDigest !== "string" || !/^[a-f0-9]{64}$/.test(job.inputDigest) ||
          !Number.isSafeInteger(job.coverageStart) || (job.coverageStart as number) < 0 || (job.coverageStart as number) > (job.inputCount as number) ||
          (Object.values(job.stages).some(state => state !== "complete") && !job.history && job.messages.length !== job.inputCount)) throw new Error("Invalid memory coverage boundary");
      }
      if (job.voiceEvidence !== undefined && (!record(job.voiceEvidence) || !strings(job.voiceEvidence, ["utteranceId", "rawText", "correctedText"]))) throw new Error("Invalid queued speech evidence");
      ids.add(job.id as string);
    }
  }

}

export function withoutPersonalMemory(messages: AgentMessage[]): AgentMessage[] {
	for (const message of messages) assertMessageContent(message);
	const names = new Set(["memory_search", "memory_dump", "conversation_history"]);
	return messages.filter((m) => m.role !== "memory-context" && (m as {role:string}).role !== "memory-delivery" && m.role !== "compactionSummary" &&
		!(m.role === "toolResult" && names.has(m.toolName))).map((m) => {
		if (m.role !== "assistant") return m;
		return { ...m, content: m.content.filter((block) => block.type !== "toolCall" || !names.has(block.name)) };
	});
}
