import { html, nothing } from "lit";
import type { AnswerSources } from "../../answer-sources.js";

export function renderAnswerSources(evidence?: AnswerSources) {
	if (!evidence?.sources.length) return nothing;
	const cited = evidence.kind === "cited";
	const heading = cited ? "Sources" : "Consulted";
	return html`<section class="mx-4 text-sm text-muted-foreground" aria-label=${heading}>
		<div class="font-medium">${heading}</div>
		<div class="text-xs">${cited ? "Cited in this answer" : "Retrieved while researching; not cited in the answer"}</div>
		<ul class="mt-1 list-disc pl-5">${evidence.sources.map(source => html`<li>
			<a class="text-primary underline" href=${source.source_url} target="_blank" rel="noopener noreferrer">${source.title}</a>
		</li>`)}</ul>
	</section>`;
}
