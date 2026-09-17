// Memory-indicator button — the pipeline's visible pulse.
//
// The left gutter makes RETRIEVAL visible and the right gutter shows the
// pipeline's actions; this button is the at-a-glance state. It mounts in the
// editor immediately left of the mic button (sibling cluster: [memory][mic]
// [send]) and reflects the whole memory pipeline:
//   off     — memory consent not granted (dim/gray); click offers to turn it on
//   saved   — memory on, pipeline idle (dim green)
//   running — pipeline agents in flight this turn (warm-orange pulse)
//
// The composer lifecycle reattaches this persistent control to its current slot.

import { html, render } from "lit";
import { mountEditorControl } from "./editor-controls.js";
import { Brain, createElement } from "lucide";

export type MemoryVisual = "off" | "saved" | "running" | "failed";

export interface MemoryButtonSeam {
	// Current visual state, read on every (re-)render.
	getVisual: () => MemoryVisual;
	// Click handler — offers consent when off; a no-op when on.
	onClick: () => void;
}

const STYLE_ID = "cw-memory-style";
const STYLES = `
.cw-mem { height: 2rem; width: 2rem; border-radius: .5rem; display: inline-grid;
	place-items: center; cursor: pointer; background: transparent; color: #34d399;
	border: none; transition: color .12s, background .12s, opacity .12s; }
.cw-mem:hover { color: #6ee7b7; background: color-mix(in srgb, #34d399 12%, transparent); }
.cw-mem:focus-visible { outline: 2px solid #34d399; outline-offset: 1px; }
.cw-mem--off { color: #6b7280; opacity: .65; }
.cw-mem--saved { opacity: .45; }
.cw-mem--failed { color: #f87171; }
.cw-mem--running { color: #fb923c; } /* warm orange while the pipeline works — distinct from the idle green */
.cw-mem--running svg { animation: cw-mem-pulse 1.1s infinite; }
@keyframes cw-mem-pulse { 0%,100% { opacity: 1; } 50% { opacity: .3; } }
`;

function ensureStyles(): void {
	if (document.getElementById(STYLE_ID)) return;
	const el = document.createElement("style");
	el.id = STYLE_ID;
	el.textContent = STYLES;
	document.head.appendChild(el);
}

const LABELS: Record<MemoryVisual, string> = {
	off: "Memory off — click to turn on",
	saved: "Memory on",
	running: "Memory working…",
	failed: "Memory paused after failure — click to retry",
};

export class MemoryButton {
	private host: HTMLSpanElement;
	private unmountControl: () => void;

	constructor(private seam: MemoryButtonSeam) {
		ensureStyles();
		this.host = document.createElement("span");
		this.host.style.display = "inline-flex";
		this.renderButton();
		this.unmountControl = mountEditorControl(this.host, 1);
	}

	// Re-render from the current visual state. Called by the host when pipeline or
	// consent state changes.
	refresh(): void {
		this.renderButton();
	}

	private renderButton(): void {
		const v = this.seam.getVisual();
		const label = LABELS[v];
		const cls = v === "failed" ? "cw-mem--failed" : v === "off" ? "cw-mem--off" : v === "running" ? "cw-mem--running" : "cw-mem--saved";
		const svg = createElement(Brain);
		svg.setAttribute("width", "18");
		svg.setAttribute("height", "18");
		svg.setAttribute("aria-hidden", "true");
		render(
			html`
				<button
					class="cw-mem ${cls}"
					title=${label}
					aria-label=${label}
					@click=${() => this.seam.onClick()}
				>
					${svg}
				</button>
			`,
			this.host,
		);
	}

	destroy(): void {
		this.unmountControl();
		this.host.remove();
	}
}

export function installMemoryButton(seam: MemoryButtonSeam): MemoryButton {
	return new MemoryButton(seam);
}
