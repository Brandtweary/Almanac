import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { SttLexicon } from "./stt-lexicon.js";

function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }
const strings = (value: Record<string, unknown>, keys: string[]) => keys.every((key) => typeof value[key] === "string");

/** Reject malformed imports before changing live state; optional evidence survives round trips. */
export function validateSttLexicon(value: unknown): asserts value is SttLexicon {
  if (!record(value) || !Array.isArray(value.autoReplace) || !Array.isArray(value.mistranscriptions)) throw new Error("Invalid speech memory");
  for (const row of value.autoReplace) {
    if (!record(row) || !strings(row, ["from", "to", "ts"]) || !(row.from as string).trim() || !(row.to as string).trim()) throw new Error("Invalid speech replacement rule");
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
  validateSttLexicon(value.sttLexicon); validateRunningContext(value.runningContext);
  for (const agent of ["audit", "memory", "summary"]) {
    const entries = value.buffers[agent];
    if (!Array.isArray(entries) || entries.some((row) => !record(row) || !strings(row, ["ts", "note"]) ||
      !Array.isArray(row.actions) || row.actions.some((action) => typeof action !== "string"))) throw new Error("Invalid memory action buffer");
  }
  for (const flag of value.flags) {
    if (!record(flag) || !strings(flag, ["kind", "description", "ts"]) || (flag.label !== undefined && typeof flag.label !== "string")) throw new Error("Invalid memory review flag");
  }
}

export function withoutPersonalMemory(messages: AgentMessage[]): AgentMessage[] {
	const names = new Set(["memory_search", "memory_dump"]);
	return messages.filter((m) => m.role !== "memory-context" && m.role !== "compactionSummary" &&
		!(m.role === "toolResult" && names.has(m.toolName))).map((m) => {
		if (m.role !== "assistant") return m;
		return { ...m, content: m.content.filter((block) => block.type !== "toolCall" || !names.has(block.name)) };
	});
}
