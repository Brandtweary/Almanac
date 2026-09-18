import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { EvidenceLedger, inspectCorpusCitations, validateEvidence, type EvidenceRecord } from "./corpus-tools.js";
import { isUserMessage } from "./user-messages.js";

/** "cited" reports the answer's own validated citations; "consulted" reports retrieval that the answer never cited. */
export interface AnswerSources { kind: "cited" | "consulted"; sources: EvidenceRecord[] }
/** Payload identity also matches the structured-cloned original archive. */
export const answerIdentity = (message: AssistantMessage): string => JSON.stringify([
	message.timestamp, message.responseId ?? null, message.content, message.stopReason,
]);

/** One document, one footer entry: the first cited or returned passage carries its link. */
const documentKey = (record: EvidenceRecord) => JSON.stringify([record.document_id, record.source_revision]);
function byDocument(records: readonly EvidenceRecord[]): EvidenceRecord[] {
	const unique = new Map<string, EvidenceRecord>();
	for (const record of records) if (!unique.has(documentKey(record))) unique.set(documentKey(record), record);
	return [...unique.values()];
}
const answerText = (message: AssistantMessage): string =>
	message.content.filter(part => part.type === "text").map(part => part.text).join("\n");

/**
 * The footer reports the answer's own citations, validated against the evidence the corpus
 * actually returned in this conversation. Retrieval that the answer never cited is reported
 * separately and never presented as support.
 */
export function collectAnswerSources(messages: readonly AgentMessage[], origin?: string): Map<string, AnswerSources> {
	const base = origin ?? globalThis.location?.origin ?? "http://localhost";
	const answers = new Map<string, AnswerSources>();
	let active = false;
	// Citation handles stay resolvable across turns: an answer may rely on a passage read earlier.
	const ledger = new EvidenceLedger();
	const calls = new Map<string, string>();
	const read = new Map<string, EvidenceRecord>();
	const search = new Map<string, EvidenceRecord>();
	for (const message of messages) {
		if (message.role === "corpus-ledger") { ledger.restore([message]); continue; }
		if (isUserMessage(message) || message.role === "compactionSummary") {
			active = isUserMessage(message);
			calls.clear(); read.clear(); search.clear();
			continue;
		}
		if (message.role === "assistant") {
			for (const part of message.content) if (part.type === "toolCall" &&
				(part.name === "corpus_search" || part.name === "corpus_read")) calls.set(part.id, part.name);
			if (!active) continue;
			if (message.stopReason !== "toolUse" && message.content.some(part => part.type === "text" && part.text.trim())) {
				const cited = byDocument(inspectCorpusCitations(answerText(message), ledger, base).known);
				answers.set(answerIdentity(message), cited.length
					? { kind: "cited", sources: cited }
					: { kind: "consulted", sources: [...(read.size ? read : search).values()] });
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
					if (active) target.set(documentKey(record), record);
				} catch { /* Invalid saved evidence cannot acquire a navigable source link. */ }
			}
		}
	}
	return answers;
}
