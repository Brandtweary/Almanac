import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { EvidenceLedger, validateEvidence, type EvidenceRecord } from "./corpus-tools.js";
import { isUserMessage } from "./user-messages.js";

export interface AnswerSources { kind: "read" | "search"; sources: EvidenceRecord[] }
/** Payload identity also matches the structured-cloned original archive. */
export const answerIdentity = (message: AssistantMessage): string => JSON.stringify([
	message.timestamp, message.responseId ?? null, message.content, message.stopReason,
]);

export function collectAnswerSources(messages: readonly AgentMessage[]): Map<string, AnswerSources> {
	const answers = new Map<string, AnswerSources>();
	let active = false;
	let ledger = new EvidenceLedger();
	const calls = new Map<string, string>();
	const read = new Map<string, EvidenceRecord>();
	const search = new Map<string, EvidenceRecord>();
	for (const message of messages) {
		if (isUserMessage(message) || message.role === "compactionSummary") {
			active = isUserMessage(message);
			calls.clear(); read.clear(); search.clear();
			ledger = new EvidenceLedger();
			continue;
		}
		if (!active) continue;
		if (message.role === "assistant") {
			for (const part of message.content) if (part.type === "toolCall" &&
				(part.name === "corpus_search" || part.name === "corpus_read")) calls.set(part.id, part.name);
			if (message.stopReason !== "toolUse" && message.content.some(part => part.type === "text" && part.text.trim())) {
				const sources = read.size ? read : search;
				answers.set(answerIdentity(message), { kind: read.size ? "read" : "search", sources: [...sources.values()] });
			}
		} else if (message.role === "toolResult" && calls.get(message.toolCallId) === message.toolName) {
			calls.delete(message.toolCallId);
			if (message.isError) continue;
			const details = message.details as { hits?: unknown; passages?: unknown } | undefined;
			const rows = message.toolName === "corpus_read" ? details?.passages : details?.hits;
			if (!Array.isArray(rows)) continue;
			const target = message.toolName === "corpus_read" ? read : search;
			for (const row of rows) {
				try {
					const evidence = validateEvidence(row);
					ledger.remember([evidence]);
					const record = ledger.resolve(evidence.passage_id)!;
					target.set(JSON.stringify([record.document_id, record.source_revision]), record);
				} catch { /* Invalid saved evidence cannot acquire a navigable source link. */ }
			}
		}
	}
	return answers;
}
