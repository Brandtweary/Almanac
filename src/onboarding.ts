import { html } from "lit";

const suggestions = [
	"Why is my compost staying wet?",
	"What should I measure before planning microhydro power?",
	"How does crop rotation help the soil?",
];

export function renderOnboarding(disabled: boolean, choose: (text: string) => void) {
	return html`<section class="cw-onboarding py-8 sm:py-12 text-muted-foreground" aria-label="Getting started">
		<h1 class="text-lg mb-2">Local AI for self-reliance and homesteading.</h1>
		<p class="text-sm mb-5">Ask about a repair, a growing problem, or how something works.</p>
		<div class="flex flex-col items-start gap-2 mb-6" aria-label="Example questions">
			${suggestions.map(question => html`<button type="button" class="text-sm text-left rounded px-2 py-1 -ml-2 hover:text-primary focus-visible:outline focus-visible:outline-primary disabled:opacity-50 disabled:cursor-default" ?disabled=${disabled} @click=${() => choose(question)}>${question}</button>`)}
		</div>
	</section>`;
}
