import { SettingsTab } from "./pi-web-ui/index.js";
import { html, type TemplateResult } from "lit";
import { state } from "lit/decorators.js";
import type { MaintenanceDecision } from "./glossary-maintenance.js";
import type { ReviewFlag } from "./pipeline-tools.js";

export interface MemoryTabCallbacks {
	isEnabled: () => boolean;
	hasFailedWork: () => boolean;
	retry: () => void;
	setEnabled: (on: boolean) => Promise<void>;
	onExport: () => void;
	onImport: (file: File) => Promise<void>;
	onDelete: () => Promise<void>;
	// Unresolved review flags, newest first; resolution removes a handled item.
	getFlags: () => ReviewFlag[];
	getGlossaryDecisions?: () => MaintenanceDecision[];
	forgetGlossaryDecision?: (ids: [string,string]) => Promise<void>;
	resolveFlag: (flag: ReviewFlag) => Promise<void>;
}

// The Memory tab: the single home for memory in Settings — turn it on or off after
// the initial consent prompt, and export / import / delete the stored lexicon (the
// whole memory artifact — the term glossary plus speech-adaptation data and
// conversation summaries; there is nothing else to export). Off disables personal
// memory access and background processing; saved memory is retained. Browser storage can be evicted, so the
// file export is the real durability story (the framework's PersistentStorageDialog
// is broken upstream). main.ts supplies the callbacks since the live stores live there.
export class MemoryTab extends SettingsTab {
	@state() private enabled = false;
	@state() private reviewMessage = "";

	constructor(private readonly cbs: MemoryTabCallbacks) {
		super();
		this.enabled = cbs.isEnabled();
	}

	getTabName(): string {
		return "Memory";
	}

	render(): TemplateResult {
		const toggle = async () => {
			const next = !this.enabled;
			try { await this.cbs.setEnabled(next); this.enabled = next; }
			catch (error) { this.enabled = this.cbs.isEnabled(); alert(`Memory setting failed: ${error}`); }
		};
		const onFile = async (e: Event) => {
			const input = e.target as HTMLInputElement;
			const file = input.files?.[0];
			input.value = "";
			if (!file) return;
			try {
				await this.cbs.onImport(file);
			} catch (err) {
				alert(`Import failed: ${err instanceof Error ? err.message : String(err)}`);
			}
		};
		const onDelete = async () => {
			if (!confirm("Delete your memory? This can't be undone.")) return;
			try { await this.cbs.onDelete(); alert("Your memory has been deleted."); }
			catch (error) { alert(`Delete failed: ${error}`); }
		};
		return html`
			<div class="flex flex-col gap-4 p-1">
				<p class="text-sm text-muted-foreground">
					Almanac remembers your conversations as a personal memory, kept only in this browser.
					When enabled, relevant text is processed by the configured AI services, including bounded
					pronunciation checks that do not store glossary or speech text on the backend.
				</p>
				<div class="flex items-center gap-3">
					<button
						class="rounded border border-primary px-3 py-1.5 text-sm text-primary hover:opacity-80"
						@click=${toggle}
					>
						${this.enabled ? "Turn memory off" : "Turn memory on"}
					</button>
					<span class="text-sm text-muted-foreground">
						Memory is <span class="text-primary">${this.enabled ? "on" : "off"}</span>.
					</span>
				</div>
				${this.cbs.hasFailedWork() ? html`<p role="status">Memory paused after a failed update. Saved memory is intact. <button class="underline" @click=${() => { this.cbs.retry(); this.requestUpdate(); }}>Retry</button></p>` : null}
				<hr class="border-border" />
				<p class="text-sm text-muted-foreground">
					Save your memory and its background work records to a file you can re-import later or move to another browser.
				</p>
				<div class="flex flex-wrap gap-3">
					<button
						class="rounded border border-primary px-3 py-1.5 text-sm text-primary hover:opacity-80"
						@click=${() => this.cbs.onExport()}
					>
						Export
					</button>
					<label
						class="cursor-pointer rounded border border-primary px-3 py-1.5 text-sm text-primary hover:opacity-80"
					>
						Import
						<input type="file" accept="application/json" class="hidden" @change=${onFile} />
					</label>
					<button
						class="rounded border border-red-400 px-3 py-1.5 text-sm text-red-400 hover:opacity-80"
						@click=${onDelete}
					>
						Delete
					</button>
				</div>
				${this.renderFlags()}
				${this.renderGlossaryDecisions()}
			</div>
		`;
	}

	private renderGlossaryDecisions(): TemplateResult | null {
		const decisions = (this.cbs.getGlossaryDecisions?.() ?? []).filter(row => row.verdict === "distinct" && !row.forgottenAt);
		if (!decisions.length && !this.reviewMessage) return null;
		return html`<hr class="border-border" /><details><summary class="text-sm">Terms kept separate (${decisions.length})</summary>
		<p class="text-sm text-muted-foreground">These pairs stay separate unless you allow another review. Review resumes during a later conversation turn while memory is on.</p>
		<ul>${decisions.map(row => html`<li class="text-xs my-2">${row.before.map(term => term.label).join(" / ")}: ${row.reason}
		<button class="ml-2 underline" ?disabled=${!this.enabled} @click=${async () => {
			try { await this.cbs.forgetGlossaryDecision?.(row.ids); this.reviewMessage = "Another review is allowed during a later conversation turn."; this.requestUpdate(); }
			catch(error) { alert(`Could not allow another review: ${error}`); }
		}}>Allow review</button></li>`)}</ul></details><p role="status" class="text-sm">${this.reviewMessage}</p>`;
	}

	// Human-review flags remain visible until resolved.
	private renderFlags(): TemplateResult | null {
		const flags = this.cbs.getFlags();
		if (!flags.length) return null;
		return html`
			<hr class="border-border" />
			<p class="text-sm text-muted-foreground">
				Flagged for your review (${flags.length}) — memory issues the pipeline left for a human:
			</p>
			<ul class="flex flex-col gap-1.5">
				${flags.map(
					(f) => html`<li class="text-xs text-muted-foreground">
						<span class="text-primary">${f.kind}</span>${f.label ? html` · ${f.label}` : ""}: ${f.description}
						<button class="ml-2 underline" @click=${async () => {
							try { await this.cbs.resolveFlag(f); this.requestUpdate(); }
							catch (error) { alert(`Could not resolve flag: ${error}`); }
						}}>Resolve</button>
					</li>`,
				)}
			</ul>
		`;
	}
}

if (!customElements.get("memory-tab")) {
	customElements.define("memory-tab", MemoryTab);
}
