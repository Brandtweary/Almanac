// The browser web-search tool calls the local gateway's GET endpoint with q/limit
// and renders titled results independently of the installed reference library.

import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { ToolRenderer } from "./pi-web-ui/index.js";
import { registerToolRenderer, renderHeader } from "./pi-web-ui/index.js";
import { Globe } from "lucide";
import { type Static, Type } from "typebox";

export interface WebSearchResult {
	title: string;
	url: string;
	snippet: string;
}

// Third-party result fields are rendered through marked→unsafeHTML downstream, so
// neutralize angle-brackets here (defense-in-depth) — an injected <form>/<a> can't
// reach the HTML sink even if the renderer's own guards regress.
function stripAngles(s: unknown): string {
	return String(s ?? "").replace(/[<>]/g, "");
}

// Fetch web results through the local gateway. Throws on a non-OK response or a
// timeout so the agent loop synthesizes an error result.
export async function webSearch(
	endpoint: string,
	bearer: string,
	query: string,
	limit = 8,
	signal?: AbortSignal,
): Promise<{ results: WebSearchResult[]; degraded: boolean }> {
	const url = `${endpoint}?q=${encodeURIComponent(query)}&limit=${encodeURIComponent(String(limit))}`;
	const res = await fetch(url, {
		// The bundled gateway needs no credential; a bearer is attached only when
		// a deployment points this tool at an endpoint that requires one.
		headers: bearer ? { Authorization: `Bearer ${bearer}` } : {},
		signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000),
	});
	if (!res.ok) throw new Error(`web search failed: HTTP ${res.status}`);
	const data = await res.json();
	if (!data || !Array.isArray(data.results) || data.results.some((r: unknown) =>
		!r || typeof r !== "object" || ["title", "url", "snippet"].some((key) =>
			typeof (r as Record<string, unknown>)[key] !== "string"))) {
		throw new Error("web search returned an invalid response");
	}
	return { results: data.results, degraded: data.degraded === true };
}

const webSearchSchema = Type.Object({
	query: Type.String({ description: "The search query." }),
	limit: Type.Optional(Type.Number({ description: "Max results (default 8, capped at 8)." })),
});

export function createWebSearchTool(opts: { endpoint: string; getBearer: () => string }): AgentTool<typeof webSearchSchema> {
	return {
		name: "web_search",
		label: "Web search",
		description:
			"Search the web for current information beyond what you already know — recent events, " +
			"specific facts, anything that needs a live lookup. Returns a short list of titled results " +
			"with links and snippets.",
		parameters: webSearchSchema,
		execute: async (_id, params: Static<typeof webSearchSchema>, signal) => {
			const limit = Math.min(Math.max(params.limit ?? 8, 1), 8);
			const { results, degraded } = await webSearch(opts.endpoint, opts.getBearer(), params.query, limit, signal);
			const text = results.length
				? results
						.slice(0, limit)
						.map((r, i) => `${i + 1}. **${stripAngles(r.title)}**\n   ${stripAngles(r.url)}\n   ${stripAngles(r.snippet).slice(0, 200)}`)
						.join("\n\n")
				: `No web results for "${params.query}".`;
			return {
				content: [{ type: "text", text: degraded ? `Some search engines failed; these results are incomplete.\n\n${text}` : text }],
				details: { degraded, results: results.map((r) => ({ title: r.title, url: r.url })) },
			};
		},
	};
}

const webSearchRenderer: ToolRenderer = {
	render: (_params, result) => {
		const state = result ? (result.isError ? "error" : "complete") : "inprogress";
		if (result && !result.isError) {
			const n = (result.details as { results?: unknown[] } | undefined)?.results?.length ?? 0;
			return {
				content: renderHeader(state, Globe, `Searched the web · ${n} result${n === 1 ? "" : "s"}`),
				isCustom: false,
			};
		}
		return { content: renderHeader(state, Globe, result?.isError ? "Web search failed" : "Searching the web…"), isCustom: false };
	},
};

export function registerWebToolRenderer(): void {
	registerToolRenderer("web_search", webSearchRenderer);
}
