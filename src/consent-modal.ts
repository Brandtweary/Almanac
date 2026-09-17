// Memory consent modal — the one-time opt-in for the personal memory.
//
// Myriapod's thesis is sovereign, local memory, so asking permission to remember
// is the feature, not an apology. Shown once on the visitor's first interaction
// (first send OR first mic toggle); the choice persists per browser and can be
// changed later in Settings → Memory. Reuses the generic modal shell (cw-modal-*).

import { html, render } from "lit";

export type ConsentChoice = "granted" | "declined";

/** Show the consent modal; resolves with the visitor's choice once they pick. */
export function showConsentModal(): Promise<ConsentChoice> {
	return new Promise((resolve) => {
		const overlay = document.createElement("div");
		overlay.className = "cw-modal-overlay";

		const finish = (choice: ConsentChoice) => {
			overlay.remove();
			resolve(choice);
		};

		render(
			html`
				<div class="cw-modal" role="dialog" aria-modal="true" aria-labelledby="cw-consent-title">
					<h2 id="cw-consent-title" class="cw-modal-title">Remember conversations?</h2>
					<p class="cw-modal-body">
						Almanac can remember what you tell it across conversations. Saved memory stays
						<strong>in this browser</strong>, and you can export or delete it in Settings.
						When enabled, relevant conversation and memory text goes to the configured AI services;
						small glossary and speech fragments can also be checked for pronunciation without backend storage.
						Those services run on your own machine in a local installation. Turn memory on?
					</p>
					<div class="cw-modal-actions">
						<button class="cw-modal-primary" @click=${() => finish("granted")}>Yes, remember</button>
						<button class="cw-modal-secondary" @click=${() => finish("declined")}>No thanks</button>
					</div>
				</div>
			`,
			overlay,
		);

		document.body.appendChild(overlay);
	});
}
