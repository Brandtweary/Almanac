import { validatedTokenUsage } from "../token-usage.js";
import { admitPayload, beginRequest } from "../oracle-runtime.js";
import { releaseProfile, type OracleRole } from "../local-model.js";
// Shared machinery for the memory pipeline's LLM legs: the completion seam,
// injected-context stripping, the existing-memory dump, and the thin-turn guard.
// The agents themselves (prompts + tool loops) live in src/pipeline*.ts.

import { NLTK_ENGLISH_STOPWORDS } from "./stopwords";
import { tokenize } from "./stem";
import type { Graph } from "./graph";

// -- LLM completion seam ----------------------------------------------------

export interface ChatMessage {
	role: "system" | "user" | "assistant";
	content: string;
}
export type CompletionFn = (messages: ChatMessage[], signal?: AbortSignal) => Promise<string>;

export interface CompletionOpts {
	baseUrl: string; // OpenAI-compatible base, e.g. http://.../llm/v1
	model: string;
	apiKey?: string; // Legacy caller compatibility; never transmitted.
	role?: OracleRole;
	conversationId?: string;
	// Reports the call's token usage if the caller wants it (unused locally — there
	// is no per-token cost to fold into the session total).
	onUsage?: (usage: { promptTokens: number; completionTokens: number }) => void;
	reasoningEffort?: string; // Profile-owned provider reasoning configuration.
}

/** One-shot completion through the same local admission path as chat. */
export function makeCompletion(opts: CompletionOpts): CompletionFn {
	return async (messages, signal) => {
		const role = opts.role ?? "summary";
		const profile = releaseProfile();
		const thinking = profile.roles[role].thinkingLevel;
		const payload = await admitPayload({ model: profile.model.id, messages, stream: false,
			...(profile.model.reasoning && thinking ? { reasoning_effort: thinking } : {}),
		}, role, signal);
		const request = beginRequest(role, opts.conversationId ?? crypto.randomUUID(), signal);
		try {
		const res = await fetch(`${opts.baseUrl}/chat/completions`, {
			method: "POST", headers: { "Content-Type": "application/json", ...request.headers },
			body: JSON.stringify(payload), signal,
		});
		if (!res.ok) {
			throw new Error(`completion failed: ${res.status} ${await res.text()}`);
		}
		const data = await res.json();
		const choice = data?.choices?.[0];
		if (!choice || typeof choice.message?.content !== "string") {
			throw new Error("completion returned no text response");
		}
		if (choice.finish_reason !== "stop") {
			throw new Error(`completion did not finish successfully: ${choice.finish_reason ?? "missing finish reason"}`);
		}
		const usage = validatedTokenUsage(data?.usage, "openai", true);
		opts.onUsage?.({ promptTokens: usage.input, completionTokens: usage.output });
		request.finish("complete");
		return choice.message.content;
		} catch (error) { request.finish(signal?.aborted ? "interrupted" : "failed"); throw error; }
	};
}

// -- Strip injected context -------------------------------------------------

const STRIP_TAGS: Array<[string, string]> = [["<memory>", "</memory>"]];

/** Remove the hidden memory breadcrumb from turn text so injected retrieval
 *  never pollutes downstream text processing. (The pipeline agents' transcript
 *  KEEPS the breadcrumbs — retrieval visibility is the audit agent's subject
 *  matter; this strip is for narrower uses like the thin-turn guard.) */
export function stripInjectedContext(text: string): string {
	for (const [open, close] of STRIP_TAGS) {
		let idx: number;
		while ((idx = text.indexOf(open)) !== -1) {
			const end = text.indexOf(close, idx);
			if (end === -1) text = text.slice(0, idx);
			else text = text.slice(0, idx) + text.slice(end + close.length);
		}
	}
	return text.trim();
}

// -- Existing-memory dump ---------------------------------------------------

/** Render every term in the personal memory as in-prompt context: label, type,
 *  aliases, and description. At personal scale this whole-store dump is what
 *  lets the model itself judge semantic duplicates and reuse exact labels. */
export function dumpExistingContext(graph: Graph): string {
	const nodes = [...graph.thoughts.values()];
	if (nodes.length === 0) return "(the personal memory is empty — nothing remembered yet)";
	nodes.sort((a, b) => (a.label < b.label ? -1 : a.label > b.label ? 1 : 0));

	const lines: string[] = [];
	for (const n of nodes) {
		const type = n.entity_type ? ` (${n.entity_type})` : "";
		const aliases = n.aliases.length ? ` [aliases: ${n.aliases.join(", ")}]` : "";
		const desc = n.description ? ` — ${n.description}` : "";
		lines.push(`- ${n.label}${type}${aliases}${desc}`);
	}
	return lines.join("\n");
}

// -- Thin-turn guard ----------------------------------------------------------

/** At least one non-stopword content token of length > 2. Skips "ok"/"thanks"-
 *  class turns that do not require memory work. */
export function hasContentWords(text: string): boolean {
	return tokenize(text).some((t) => t.length > 2 && !NLTK_ENGLISH_STOPWORDS.has(t));
}
