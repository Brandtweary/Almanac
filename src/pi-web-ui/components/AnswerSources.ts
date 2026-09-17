import { html, nothing } from "lit";
import type { AnswerSources } from "../../answer-sources.js";

export function renderAnswerSources(evidence?: AnswerSources) {
	if (!evidence?.sources.length) return nothing;
	return html`<section class="mx-4 text-sm text-muted-foreground" aria-label="Sources">
		<div class="font-medium">Sources</div>
		<div class="text-xs">${evidence.kind === "read" ? "Read from the library" : "Search results"}</div>
		<ul class="mt-1 list-disc pl-5">${evidence.sources.map(source => html`<li>
			<a class="text-primary underline" href=${source.source_url} target="_blank" rel="noopener noreferrer">${source.title}</a>
		</li>`)}</ul>
	</section>`;
}
