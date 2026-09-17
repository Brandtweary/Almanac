import { html } from "lit";
import { createRef, ref } from "lit/directives/ref.js";
import { BookOpen, History, Search } from "lucide";
import { registerToolRenderer, renderCollapsibleHeader } from "./pi-web-ui/tools/renderer-registry.js";
import type { ToolRenderer } from "./pi-web-ui/tools/types.js";

/** Reference tools use the existing compact card and opt-in debug disclosure. */
function referenceRenderer(icon: unknown, pending: string, complete: string, failed: string, countKey?: "hits" | "passages"): ToolRenderer {
	return {
		render: (params, result) => {
			const state = result ? result.isError ? "error" : "complete" : "inprogress";
			const details = result?.details as { hits?: unknown[]; passages?: unknown[]; status?: string } | undefined;
			const count = countKey && Array.isArray(details?.[countKey]) ? details![countKey]!.length : undefined;
			const label = result ? result.isError ? failed : complete + (count === undefined ? "" : ` · ${count} passage${count === 1 ? "" : "s"}`) +
				(details?.status === "degraded" ? " · incomplete results" : "") : pending;
			const contentRef = createRef<HTMLElement>();
			const chevronRef = createRef<HTMLElement>();
			return {
				content: html`<div>
					${renderCollapsibleHeader(state, icon, label, contentRef, chevronRef, false)}
					<div ${ref(contentRef)} class="max-h-0 overflow-hidden transition-all duration-300">
						<tool-message-debug .callArgs=${params} .result=${result} .hasResult=${Boolean(result)}></tool-message-debug>
					</div>
				</div>`,
				isCustom: false,
			};
		},
	};
}

export function registerReferenceToolRenderers(): void {
	registerToolRenderer("corpus_search", referenceRenderer(Search, "Searching library…", "Searched library", "Library search failed", "hits"));
	registerToolRenderer("corpus_read", referenceRenderer(BookOpen, "Reading source…", "Read source", "Source read failed", "passages"));
	registerToolRenderer("conversation_history", referenceRenderer(History, "Reading conversation history…", "Read conversation history", "Conversation history read failed"));
}
