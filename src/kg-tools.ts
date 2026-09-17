export { createMemorySearchTool, createMemoryDumpTool } from "./memory-tools.js";
import type { ToolRenderer } from "./pi-web-ui/index.js";
import { registerToolRenderer, renderHeader } from "./pi-web-ui/index.js";
import { Database, Search } from "lucide";

// ---------------------------------------------------------------------------
// Tool renderers (compact labels over pi-web-ui's spinner card)
// ---------------------------------------------------------------------------
const memorySearchRenderer: ToolRenderer = {
	render: (_params, result) => {
		const state = result ? (result.isError ? "error" : "complete") : "inprogress";
		if (result && !result.isError) {
			const n = (result.details as { count?: number } | undefined)?.count ?? 0;
			return {
				content: renderHeader(state, Search, `Searched memory · ${n} term${n === 1 ? "" : "s"}`),
				isCustom: false,
			};
		}
		return { content: renderHeader(state, Search, "Searching memory…"), isCustom: false };
	},
};

const memoryDumpRenderer: ToolRenderer = {
	render: (_params, result) => {
		const state = result ? (result.isError ? "error" : "complete") : "inprogress";
		if (result && !result.isError) {
			const d = result.details as { termCount?: number } | undefined;
			const n = d?.termCount ?? 0;
			return {
				content: renderHeader(state, Database, `Memory · ${n} term${n === 1 ? "" : "s"}`),
				isCustom: false,
			};
		}
		return { content: renderHeader(state, Database, "Reading memory…"), isCustom: false };
	},
};

export function registerMemoryToolRenderers(): void {
	registerToolRenderer("memory_search", memorySearchRenderer);
	registerToolRenderer("memory_dump", memoryDumpRenderer);
}
