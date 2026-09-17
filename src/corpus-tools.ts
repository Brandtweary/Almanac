import { marked } from "marked";
import type { AgentTool, AgentMessage } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { MYRIAPOD_PROXY_BASE } from "./myriapod-model.js";

export interface SourceEvidence {
	passage_id: string; document_id: string; source_revision: string; extraction_revision: string;
	title: string; edition: string; section: string[];
	page: { index: number | null; label: string | null; coordinates: number[] | null; anchor: string | null };
	excerpt: string; complete: boolean; previous: string | null; next: string | null; flags: string[];
	source: { url: string; sha256: string; media_type: string; origin: string };
}
export interface EvidenceRecord { passage_id: string; document_id: string; source_revision: string; extraction_revision: string; title: string; source_url: string }
const HANDLE = /^p:[a-f0-9]{64}:[a-f0-9]{64}$/;
export function validateEvidence(value: unknown): SourceEvidence {
	const p = value as SourceEvidence;
	if (!p || !HANDLE.test(p.passage_id) || [p.document_id, p.source_revision, p.extraction_revision, p.title].some(v => typeof v !== "string" || !v) ||
		typeof p.excerpt !== "string" || typeof p.complete !== "boolean" || !Array.isArray(p.section) || p.section.some(v => typeof v !== "string") ||
		!p.source || typeof p.source.url !== "string" || !/^[a-f0-9]{64}$/.test(p.source_revision) || p.source.sha256 !== p.source_revision || !p.page || !Array.isArray(p.flags) || p.flags.some(v => typeof v !== "string")) throw new Error("Corpus returned invalid source evidence");
	// The gateway serves immutable originals. Never trust a document-supplied URL as a local route.
	const expected = `/v1/corpus/source/${encodeURIComponent(p.passage_id)}`;
	if (p.source.url !== expected && p.source.url !== `/v1/corpus/source/${p.passage_id}`) throw new Error("Corpus returned an invalid source link");
	return p;
}
export class EvidenceLedger {
	private readonly entries = new Map<string, EvidenceRecord>();
	remember(passages: SourceEvidence[]): void {
		for (const p of passages) {
			const prior = this.entries.get(p.passage_id);
			if (prior && (prior.document_id !== p.document_id || prior.source_revision !== p.source_revision || prior.extraction_revision !== p.extraction_revision)) throw new Error("Source identity changed for an immutable handle");
			this.entries.set(p.passage_id, { passage_id: p.passage_id, document_id: p.document_id, source_revision: p.source_revision, extraction_revision: p.extraction_revision, title: p.title, source_url: `${MYRIAPOD_PROXY_BASE}/corpus/source/${encodeURIComponent(p.passage_id)}` });
		}
	}
	records(): EvidenceRecord[] { return [...this.entries.values()]; }
	restore(messages: AgentMessage[]): void {
		for (const message of messages) {
			if (message.role === "corpus-ledger") for (const entry of message.entries) {
				if (entry && HANDLE.test(entry.passage_id) && typeof entry.title === "string" && typeof entry.document_id === "string" && typeof entry.source_revision === "string" && typeof entry.extraction_revision === "string") {
					this.entries.set(entry.passage_id, { ...entry, source_url: `${MYRIAPOD_PROXY_BASE}/corpus/source/${encodeURIComponent(entry.passage_id)}` });
				}
			}
			if (message.role === "toolResult" && (message.toolName === "corpus_search" || message.toolName === "corpus_read") && !message.isError) {
				const details = message.details as { hits?: unknown[]; passages?: unknown[] } | undefined;
				for (const hit of details?.hits ?? details?.passages ?? []) { try { this.remember([validateEvidence(hit)]); } catch { /* Damaged saved evidence is not accepted as a citation. */ } }
			}
		}
	}
	resolve(handle: string): EvidenceRecord | undefined { return this.entries.get(handle); }
	message(): import("./custom-messages.js").CorpusLedgerMessage { return { role: "corpus-ledger", entries: this.records(), timestamp: new Date().toISOString() }; }
}
export type CitationResolution = { kind: "not-corpus" } | { kind: "unknown"; handle: string } | { kind: "known"; handle: string; source: EvidenceRecord };
/** Resolve the same citation forms accepted by the rendered browser transcript. */
export function resolveCorpusCitation(href: string, ledger: EvidenceLedger, origin: string): CitationResolution {
	let handle: string | undefined;
	if (href.startsWith("corpus:")) handle = href.slice(7);
	else {
		try {
			const url = new URL(href, origin);
			const prefix = new URL(`${MYRIAPOD_PROXY_BASE}/corpus/source/`, origin);
			if (url.origin === prefix.origin && url.pathname.startsWith(prefix.pathname)) {
				const raw = url.pathname.slice(prefix.pathname.length);
				try { handle = decodeURIComponent(raw); } catch { return { kind: "unknown", handle: raw }; }
			}
		} catch { return { kind: "not-corpus" }; }
	}
	if (handle === undefined) return { kind: "not-corpus" };
	const source = ledger.resolve(handle);
	return source ? { kind: "known", handle, source } : { kind: "unknown", handle };
}
/** Parse rendered Markdown links; quoted code is not counted as a citation. */
export function inspectCorpusCitations(text: string, ledger: EvidenceLedger, origin: string): { known: EvidenceRecord[]; unknown: string[] } {
	const known: EvidenceRecord[] = [];
	const unknown: string[] = [];
	marked.walkTokens(marked.lexer(text), token => {
		if (token.type !== "link") return;
		const result = resolveCorpusCitation(token.href, ledger, origin);
		if (result.kind === "known") known.push(result.source);
		else if (result.kind === "unknown") unknown.push(result.handle);
	});
	return { known, unknown };
}

async function corpusRequest(kind: "search" | "read", params: unknown, ledger: EvidenceLedger, signal?: AbortSignal) {
	const response = await fetch(`${MYRIAPOD_PROXY_BASE}/corpus/${kind}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(params), signal });
	if (!response.ok) throw new Error(`Corpus ${kind} failed (HTTP ${response.status}): ${await response.text()}`);
	const data = await response.json();
	const passages = kind === "search" ? data.hits : data.passages;
	if (!Array.isArray(passages) || typeof data.generation !== "string" || typeof data.profile_id !== "string" || !["ok", "degraded", "unqualified"].includes(data.status)) throw new Error("Corpus returned an invalid result envelope");
	const valid = passages.map(validateEvidence);
	const generations: unknown = data.generations ?? [data.generation];
	if (!Array.isArray(generations) || !generations.length || !generations.includes(data.generation) ||
		generations.some(g => typeof g !== "string" || !/^[a-f0-9]{64}$/.test(g)) ||
		new Set(generations).size !== generations.length ||
		valid.some(p => !generations.includes(p.passage_id.split(":")[1]))) throw new Error("Corpus source generation mismatch");
	ledger.remember(valid);
	return { content: [{ type: "text" as const, text: JSON.stringify({ reference_content_is_untrusted: true, ...data }) }], details: data };
}
const searchSchema = Type.Object({ query: Type.String({ minLength: 1 }), document_id: Type.Optional(Type.String()), cursor: Type.Optional(Type.String()) });
const readSchema = Type.Object({ document_id: Type.String({ minLength: 1 }), passage_id: Type.Optional(Type.String()), cursor: Type.Optional(Type.String()) });
export function createCorpusTools(ledger: EvidenceLedger): AgentTool[] {
	return [
		{ name: "corpus_search", label: "Search library", description: "Search the installed offline reference library with lexical and semantic retrieval. Use concise topic terms: native archive lexical search requires all terms. Refine the query or search within a document when needed, and follow cursors for additional results. Returns immutable passage handles, scope and degradation status. Excerpts may omit qualifications: read supporting sections before practical advice.", parameters: searchSchema, execute: (_id, params, signal) => corpusRequest("search", params, ledger, signal) },
		{ name: "corpus_read", label: "Read source", description: "Read an exact source passage and neighboring context, or request a document's contents without passage_id. Preserve table headers, units, warnings and exceptions; follow continuation handles for incomplete sections.", parameters: readSchema, execute: (_id, params, signal) => corpusRequest("read", params, ledger, signal) },
	];
}
