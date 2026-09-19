// Mic capture interface — the voice agent's front door.
//
// TRANSPORT-AGNOSTIC SHELL. This module owns everything independent of how audio
// actually reaches the model: the mic button (mounted into the editor, just left
// of Send), the toggle state machine, the keyboard shortcut, the browser
// mic-permission flow, and the recording indicator. The actual audio transport
// (the browser-orchestrated STT→LLM→TTS cascade — see stt.ts/tts.ts) plugs into the
// `onStart(stream) / onStop()` seam.
//
// Interaction model: TOGGLE, not push-to-talk. One press (button or shortcut)
// starts recording; the next ends the turn (record-off = send). Turn-based by design.

import { html, render } from "lit";
import { mountEditorControl } from "./editor-controls.js";
import { createElement, Mic, Square } from "lucide";
import { MIC_AUDIO_CONSTRAINTS } from "./stt.js";

export type VoiceCaptureSeam = {
	// Fired when recording starts, handed the live mic stream. The voice path attaches
	// its PCM capture → batch-STT pipe here (see stt.ts).
	onStart?: (stream: MediaStream) => void | Promise<void>;
	// Fired when recording stops (toggle off = end of the user's turn).
	onStop?: () => void;
};

// Ctrl+Space -- one-handed and effortless (pinky on Ctrl, thumb on Space, both bottom
// row, right next to each other). Deliberately NOT Alt-based (Alt opens browser menus
// and collides with common window-manager bindings); Space is also unclaimed by the browser, unlike
// most comfortable Ctrl+letter combos (Ctrl+B/E/G/etc. hit bookmarks/search/find). The
// handler requires NO shift/alt/meta, so Ctrl+Shift+Space etc. won't trigger. One named
// constant so the binding is a one-line change. `code` is layout-independent.
// (If a Linux IME ever swallows Ctrl+Space, we're not wedded to Ctrl — swap freely.)
export const VOICE_TOGGLE = { ctrlKey: true, code: "Space" } as const;

type State = "idle" | "requesting" | "recording" | "denied";

const STYLE_ID = "cw-voice-style";
// The mic button matches the editor's other icon buttons (h-8 w-8 / 2rem) so it
// sits flush beside Send. Neon-green idle, red pulse while recording.
const STYLES = `
.cw-mic { height: 2rem; width: 2rem; border-radius: .5rem; display: inline-grid;
	place-items: center; cursor: pointer; background: transparent; color: #34d399;
	border: none; transition: color .12s, background .12s; }
.cw-mic:hover { color: #6ee7b7; background: color-mix(in srgb, #34d399 12%, transparent); }
.cw-mic:focus-visible { outline: 2px solid #34d399; outline-offset: 1px; }
.cw-mic--rec { color: #f87171; }
.cw-mic--rec svg { animation: cw-mic-pulse 1.2s infinite; }
.cw-mic--req { color: #9ca3af; cursor: wait; }
@keyframes cw-mic-pulse { 0%,100% { opacity: 1; } 50% { opacity: .35; } }
`;

function ensureStyles(): void {
	if (document.getElementById(STYLE_ID)) return;
	const el = document.createElement("style");
	el.id = STYLE_ID;
	el.textContent = STYLES;
	document.head.appendChild(el);
}

export class VoiceController {
	private host: HTMLSpanElement;
	private state: State = "idle";
	private stream?: MediaStream;
	private unmountControl: () => void;
	private generation = 0;

	constructor(private seam: VoiceCaptureSeam) {
		ensureStyles();
		// The button lives in its own span so we can move/re-home it without
		// disturbing the editor's own DOM. Its persistent slot survives Send/Stop changes.
		this.host = document.createElement("span");
		this.host.style.display = "inline-flex";
		this.renderButton();
		window.addEventListener("keydown", this.onKey);
		this.unmountControl = mountEditorControl(this.host, 2);
	}

	private onKey = (e: KeyboardEvent) => {
		if (
			e.code === VOICE_TOGGLE.code &&
			e.ctrlKey === VOICE_TOGGLE.ctrlKey &&
			!e.altKey &&
			!e.metaKey &&
			!e.shiftKey
		) {
			e.preventDefault();
			void this.toggle();
		}
	};

	toggle = async (): Promise<void> => {
		if (this.state === "recording") return this.stop();
		if (this.state === "requesting") return;
		await this.start();
	};

	private async start(): Promise<void> {
		const generation = ++this.generation;
		this.setState("requesting");
		try {
			// This is where the mic stream is actually acquired (PcmRecorder reuses it via
			// the onStart seam), so the capture constraints must be applied HERE — a bare
			// {audio:true} would silently ignore PcmRecorder's own constraint object.
			const stream = await navigator.mediaDevices.getUserMedia({ audio: MIC_AUDIO_CONSTRAINTS, video: false });
			if (generation !== this.generation) {
				stream.getTracks().forEach((track) => track.stop());
				return;
			}
			this.stream = stream;
		} catch {
			if (generation !== this.generation) return;
			this.setState("denied");
			window.setTimeout(() => {
				if (this.state === "denied") this.setState("idle");
			}, 2000);
			return;
		}
		this.setState("recording");
		try {
			await this.seam.onStart?.(this.stream);
		} catch (err) {
			console.error("[almanac] voice onStart seam threw", err);
			if (generation === this.generation) this.cancel();
		}
	}

	private stop(): void {
		this.generation++;
		this.stream?.getTracks().forEach((t) => t.stop());
		this.stream = undefined;
		this.setState("idle");
		this.seam.onStop?.();
	}

	// Abort an in-progress recording back to idle WITHOUT firing onStop. Used when the
	// transport refuses the turn after recording started (e.g. no voice slot is free),
	// so the mic stream is released but no empty turn is sent.
	cancel(): void {
		this.generation++;
		this.stream?.getTracks().forEach((t) => t.stop());
		this.stream = undefined;
		this.setState("idle");
	}

	private setState(s: State): void {
		this.state = s;
		this.renderButton();
	}

	private renderButton(): void {
		const recording = this.state === "recording";
		const requesting = this.state === "requesting";
		const label = recording ? "Stop & send (Ctrl+Space)" : "Start voice (Ctrl+Space)";
		const svg = createElement(recording ? Square : Mic);
		svg.setAttribute("width", "18");
		svg.setAttribute("height", "18");
		svg.setAttribute("aria-hidden", "true");
		render(
			html`
				<button
					class="cw-mic ${recording ? "cw-mic--rec" : ""} ${requesting ? "cw-mic--req" : ""}"
					title=${label}
					aria-label=${label}
					aria-pressed=${recording}
					@click=${() => void this.toggle()}
				>
					${svg}
				</button>
			`,
			this.host,
		);
	}

	destroy(): void {
		this.unmountControl();
		window.removeEventListener("keydown", this.onKey);
		this.stop();
		this.host.remove();
	}
}

export function installVoiceCapture(seam: VoiceCaptureSeam): VoiceController {
	return new VoiceController(seam);
}
