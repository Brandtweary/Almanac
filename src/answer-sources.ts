import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { EvidenceLedger, inspectCorpusCitations, markdownLinkHrefs, resolveCorpusCitation, sourceDisplayName, validateEvidence, type EvidenceRecord } from "./corpus-tools.js";
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
/** The answer's prose, with tool calls and citation markup left exactly as the model wrote them. */
export const answerText = (message: AssistantMessage): string =>
	message.content.filter(part => part.type === "text").map(part => part.text).join("\n");

/** An answer is a completed reply carrying prose, as opposed to a turn that only calls tools. */
export const isAnswerMessage = (message: AssistantMessage): boolean =>
	message.stopReason !== "toolUse" && message.content.some(part => part.type === "text" && part.text.trim() !== "");

const absoluteSourceUrl = (url: string, base: string): string => {
	try { return new URL(url, base).href; } catch { return url; }
};

/** Inline links, with an optional angle-bracketed target and an optional title. */
const MARKDOWN_LINK = /\[([^\]]*)\]\(\s*(<[^>\s]*>|[^()\s]+)(?:\s+"[^"]*")?\s*\)/g;

/**
 * Citation handles are resolvable only inside this conversation, so text leaving the browser
 * carries the source link instead. A handle the corpus never returned loses its target and is
 * labelled, exactly as the rendered transcript labels it.
 */
function resolveCitationsForExport(text: string, ledger: EvidenceLedger, origin: string): string {
	const linked = new Set(markdownLinkHrefs(text));
	return text.replace(MARKDOWN_LINK, (match, label: string, target: string) => {
		const href = target.startsWith("<") ? target.slice(1, -1) : target;
		if (!linked.has(href)) return match;
		const citation = resolveCorpusCitation(href, ledger, origin);
		if (citation.kind === "not-corpus") return match;
		if (citation.kind === "unknown") return `${label} [unverified source]`;
		return `[${label}](${absoluteSourceUrl(citation.source.source_url, origin)})`;
	});
}

/**
 * The answer as a reader of the pasted text needs it: the prose with its citations pointing at
 * real source links, followed by the same footer the transcript shows, whose heading keeps
 * retrieval that the answer never cited distinguishable from the answer's own support.
 */
export function answerCopyText(
	message: AssistantMessage, evidence: AnswerSources | undefined, ledger: EvidenceLedger, origin?: string,
): string {
	const base = origin ?? globalThis.location?.origin ?? "http://localhost";
	const body = resolveCitationsForExport(answerText(message), ledger, base).trim();
	if (!evidence?.sources.length) return body;
	const heading = evidence.kind === "cited"
		? "Sources — cited in this answer:"
		: "Consulted — retrieved while researching; not cited in the answer:";
	const listed = evidence.sources.map(source =>
		`- ${sourceDisplayName(source)} — ${absoluteSourceUrl(source.source_url, base)}`);
	return [body, "", heading, ...listed].join("\n");
}

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
			if (isAnswerMessage(message)) {
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
