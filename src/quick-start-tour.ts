const STORAGE_KEY = "almanac.quick-start.v1";
const steps = [
	{ selector: "message-editor textarea", title: "Start with a question", text: "Enter sends; Shift+Enter adds a new line." },
	{ selector: ".cw-mic", title: "Voice input", text: "Click the microphone or press Ctrl+Space to start recording. Use it again to stop and send." },
	{ selector: ".cw-stop", title: "A moment of quiet", text: "Click here or press Ctrl+Alt+Space to stop the voice without stopping the written reply. Double-click to mute future speech; double-click again to unmute." },
	{ selector: ".cw-mem", title: "Let the conversation carry forward", text: "Memory is optional. Enable it here if you want Almanac to retain useful context between chats." },
	{ selector: '[title="Chats"]', title: "Find your way back", text: "Your saved conversations are here. They stay in this browser, ready for the next time you need them." },
	{ selector: '[title="New Chat"]', title: "Turn to a fresh page", text: "Start another conversation here." },
];

/** A first-visit tour explains controls without activating them. */
export class QuickStartTour {
	private dialog = document.createElement("dialog");
	private ring = document.createElement("div");
	private index = 0;
	private restoreFocus?: HTMLElement;
	private heading = document.createElement("h2");
	private text = document.createElement("p");
	private counter = document.createElement("p");
	private next = document.createElement("button");
	private back = document.createElement("button");
	private skip = document.createElement("button");
	private target?: HTMLElement;
	private disposed = false;

	constructor() {
		this.dialog.className = "cw-tour";
		this.heading.id = "quick-start-title";
		this.heading.tabIndex = -1;
		this.heading.setAttribute("aria-describedby", "quick-start-description");
		this.text.id = "quick-start-description";
		this.dialog.setAttribute("aria-labelledby", this.heading.id);
		this.dialog.setAttribute("aria-describedby", this.text.id);
		this.counter.className = "cw-tour-count";
		this.counter.setAttribute("aria-hidden", "true");
		this.ring.className = "cw-tour-ring";
		this.ring.setAttribute("aria-hidden", "true");
		this.back.textContent = "Back";
		this.skip.textContent = "Skip tour";
		this.next.className = "cw-tour-next";
		for (const button of [this.back, this.skip, this.next]) button.type = "button";
		const footer = document.createElement("div"); footer.className = "cw-tour-actions";
		footer.append(this.skip, this.back, this.next);
		const content = document.createElement("div"); content.className = "cw-tour-content";
		content.append(this.counter, this.heading, this.text, footer);
		this.dialog.append(this.ring, content);
		this.back.addEventListener("click", () => this.move(-1));
		this.next.addEventListener("click", () => this.index === steps.length - 1 ? this.finish() : this.move(1));
		this.skip.addEventListener("click", () => this.finish());
		this.dialog.addEventListener("cancel", event => { event.preventDefault(); this.finish(); });
		this.dialog.addEventListener("keydown", event => {
			// Global voice shortcuts remain inactive while this explanatory dialog owns focus.
			if (event.code === "Space" && event.ctrlKey) { event.preventDefault(); event.stopPropagation(); }
		});
		document.body.append(this.dialog);
		window.addEventListener("resize", this.position);
		window.addEventListener("scroll", this.position, true);
		window.visualViewport?.addEventListener("resize", this.position);
		window.visualViewport?.addEventListener("scroll", this.position);
	}

	startIfNew(): void {
		try { if (localStorage.getItem(STORAGE_KEY)) return; } catch { /* The tour also works without persistent browser storage. */ }
		this.start();
	}

	start(): void {
		if (this.disposed || this.dialog.open) return;
		this.restoreFocus = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
		this.index = 0;
		this.showStep();
	}

	private move(direction: number): void {
		this.index += direction;
		this.showStep(direction);
	}

	private showStep(direction = 1): void {
		while (this.index >= 0 && this.index < steps.length) {
			const target = document.querySelector<HTMLElement>(steps[this.index].selector);
			if (target?.getClientRects().length) { this.target = target; break; }
			this.index += direction;
		}
		if (this.index < 0 || this.index >= steps.length) { this.finish(); return; }
		const step = steps[this.index];
		this.heading.textContent = step.title;
		this.text.textContent = step.text;
		this.counter.textContent = `${this.index + 1} / ${steps.length}`;
		this.back.disabled = this.index === 0;
		this.next.textContent = this.index === steps.length - 1 ? "Ready" : "Next";
		if (!this.dialog.open) this.dialog.showModal();
		this.position();
		this.heading.focus({ preventScroll: true });
	}

	private position = (): void => {
		if (!this.dialog.open || !this.target) return;
		const rect = this.target.getBoundingClientRect();
		const viewport = window.visualViewport;
		const leftEdge = viewport?.offsetLeft ?? 0, topEdge = viewport?.offsetTop ?? 0;
		const width = viewport?.width ?? innerWidth, height = viewport?.height ?? innerHeight;
		const margin = 12;
		this.dialog.style.width = `${Math.min(360, width - 2 * margin)}px`;
		this.dialog.style.maxHeight = `${height - 2 * margin}px`;
		this.dialog.style.setProperty("--tour-content-height", `${Math.max(80, height - 2 * margin - 42)}px`);
		const box = this.dialog.getBoundingClientRect();
		const above = rect.top - box.height - 18 >= topEdge + margin;
		const x = Math.max(leftEdge + margin, Math.min(rect.left + rect.width / 2 - box.width / 2, leftEdge + width - box.width - margin));
		const y = Math.max(topEdge + margin, Math.min(above ? rect.top - box.height - 18 : rect.bottom + 18, topEdge + height - box.height - margin));
		this.dialog.style.left = `${x}px`;
		this.dialog.style.top = `${y}px`;
		this.dialog.dataset.placement = above ? "above" : "below";
		this.dialog.style.setProperty("--tour-arrow", `${Math.max(20, Math.min(box.width - 20, rect.left + rect.width / 2 - x))}px`);
		Object.assign(this.ring.style, { left: `${rect.left - 4}px`, top: `${rect.top - 4}px`, width: `${rect.width + 8}px`, height: `${rect.height + 8}px` });
	};

	private finish(): void {
		if (this.dialog.open) this.dialog.close();
		try { localStorage.setItem(STORAGE_KEY, "seen"); } catch { /* Storage restrictions can prevent remembering dismissal. */ }
		if (this.restoreFocus?.isConnected) this.restoreFocus.focus({ preventScroll: true });
	}

	destroy(): void {
		this.disposed = true;
		this.dialog.remove();
		window.removeEventListener("resize", this.position);
		window.removeEventListener("scroll", this.position, true);
		window.visualViewport?.removeEventListener("resize", this.position);
		window.visualViewport?.removeEventListener("scroll", this.position);
	}
}
