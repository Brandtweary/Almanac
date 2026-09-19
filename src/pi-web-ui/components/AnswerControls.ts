import { icon } from "@mariozechner/mini-lit";
import { html, LitElement, nothing } from "lit";
import { property, state } from "lit/decorators.js";
import { Check, Copy, Volume2, VolumeX } from "lucide";
import { answerSpeechState, subscribeAnswerSpeech, toggleAnswerSpeech } from "../../answer-speech.js";

type CopyState = "idle" | "copied" | "failed";

const BUTTON_CLASS =
	"flex items-center gap-1 px-1 py-0.5 text-xs rounded hover:bg-accent text-muted-foreground hover:text-accent-foreground transition-colors disabled:opacity-50 disabled:hover:bg-transparent disabled:hover:text-muted-foreground";

/**
 * Per-answer controls, below the sources footer: copy the answer with its sources, and read it
 * aloud. Streamed text is unreliable to select by hand, and an answer pasted without its
 * citations loses its grounding, so the copy carries the whole payload the footer describes.
 */
export class AnswerControls extends LitElement {
	/** The answer's identity, so one reading at a time is attributable to its own control. */
	@property() answerKey: string = "";
	/** The clipboard payload: the answer plus its sources. */
	@property() copyText: string = "";
	/** The answer's own text; speech strips citation destinations on the way to the synthesizer. */
	@property() speechText: string = "";
	@state() private copyStatus: CopyState = "idle";
	@state() private speechTick = 0;
	private revert?: ReturnType<typeof setTimeout>;
	private unsubscribe?: () => void;

	protected override createRenderRoot(): HTMLElement | DocumentFragment {
		return this;
	}

	override connectedCallback(): void {
		super.connectedCallback();
		this.style.display = "block";
		this.unsubscribe = subscribeAnswerSpeech(() => { this.speechTick++; });
	}

	override disconnectedCallback(): void {
		super.disconnectedCallback();
		clearTimeout(this.revert);
		this.unsubscribe?.();
		this.unsubscribe = undefined;
	}

	private announce(status: CopyState): void {
		this.copyStatus = status;
		clearTimeout(this.revert);
		this.revert = setTimeout(() => { this.copyStatus = "idle"; }, 1500);
	}

	private async copy(): Promise<void> {
		try {
			await navigator.clipboard.writeText(this.copyText);
			this.announce("copied");
		} catch (error) {
			// A blocked or absent clipboard is silent otherwise, leaving a dead-looking button.
			console.error("Answer copy failed", error);
			this.announce("failed");
		}
	}

	private renderCopy() {
		const label = this.copyStatus === "failed" ? "Copy blocked by the browser" : "Copy the answer and its sources";
		return html`<button @click=${() => void this.copy()} class=${BUTTON_CLASS} title=${label} aria-label=${label}>
			${this.copyStatus === "copied" ? icon(Check, "sm") : icon(Copy, "sm")}
			${this.copyStatus === "copied" ? html`<span>Copied!</span>` : this.copyStatus === "failed" ? html`<span>Copy failed</span>` : nothing}
		</button>`;
	}

	private renderSpeech() {
		const state = answerSpeechState(this.answerKey);
		if (state === "unavailable" || !this.speechText.trim()) return nothing;
		const speaking = state === "speaking";
		const label = speaking
			? "Stop reading this answer"
			: state === "muted"
				? "Voice is muted — unmute with the stop-audio control"
				: state === "busy"
					? "Voice is busy — wait for the current audio to finish"
					: "Read this answer aloud";
		return html`<button
			@click=${() => toggleAnswerSpeech(this.answerKey, this.speechText)}
			class=${BUTTON_CLASS}
			?disabled=${state === "muted" || state === "busy"}
			title=${label}
			aria-label=${label}
		>
			${speaking || state === "muted" ? icon(VolumeX, "sm") : icon(Volume2, "sm")}
			${speaking ? html`<span>Stop</span>` : nothing}
		</button>`;
	}

	override render() {
		if (!this.copyText && !this.speechText) return nothing;
		// Read once per render so a published speech transition repaints this row.
		void this.speechTick;
		return html`<div class="mx-4 mt-1 flex items-center gap-0.5" aria-live="polite">
			${this.renderCopy()}${this.renderSpeech()}
		</div>`;
	}
}

if (!customElements.get("answer-controls")) {
	customElements.define("answer-controls", AnswerControls);
}
