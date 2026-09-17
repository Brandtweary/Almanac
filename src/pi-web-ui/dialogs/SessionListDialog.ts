import { DialogContent, DialogHeader } from "@mariozechner/mini-lit/dist/Dialog.js";
import { DialogBase } from "@mariozechner/mini-lit/dist/DialogBase.js";
import { html } from "lit";
import { customElement, state } from "lit/decorators.js";
import { getAppStorage } from "../storage/app-storage.js";
import type { SessionMetadata } from "../storage/types.js";
import { validSessionMetadata } from "../storage/stores/sessions-store.js";
import { formatUsage } from "../utils/format.js";
import { i18n } from "../utils/i18n.js";

@customElement("session-list-dialog")
export class SessionListDialog extends DialogBase {
	@state() private sessions: SessionMetadata[] = [];
	@state() private loading = true;
	@state() private error = "";

	private onSelectCallback?: (sessionId: string) => void;
	private onDeleteCallback?: (sessionId: string) => void;

	protected modalWidth = "min(600px, 90vw)";
	protected modalHeight = "min(700px, 90vh)";

	static async open(onSelect: (sessionId: string) => void, onDelete?: (sessionId: string) => void) {
		const dialog = new SessionListDialog();
		dialog.onSelectCallback = onSelect;
		dialog.onDeleteCallback = onDelete;
		dialog.open();
		await dialog.loadSessions();
	}

	private async loadSessions() {
		this.loading = true;
		try {
			const storage = getAppStorage();
			this.sessions = await storage.sessions.getAllMetadata();
		} catch (err) {
			console.error("Failed to load sessions:", err);
			this.error = `Saved conversations could not be read; their data has been retained. ${String(err)}`;
			this.sessions = [];
		} finally {
			this.loading = false;
		}
	}

	private async handleExport(id: string, event: Event) {
		event.stopPropagation();
		try {
			const text = await getAppStorage().sessions.exportSession(id);
			const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
			const link = document.createElement("a");
			link.href = url; link.download = `conversation-${id}.json`; link.click();
			setTimeout(() => URL.revokeObjectURL(url), 1000);
		} catch (error) { this.error = String(error); }
	}

	private async handleImport(event: Event) {
		const input = event.target as HTMLInputElement;
		const file = input.files?.[0];
		if (!file) return;
		try {
			await getAppStorage().sessions.importSession(await file.text());
			this.error = "";
			await this.loadSessions();
		} catch (error) { this.error = String(error); }
		finally { input.value = ""; }
	}

	private async handleDelete(sessionId: string, event: Event) {
		event.stopPropagation();

		if (!confirm(i18n("Delete this session?"))) {
			return;
		}

		try {
			const storage = getAppStorage();
			if (!storage.sessions) return;

			await storage.sessions.deleteSession(sessionId);
			// Invalidate an active conversation immediately, before another terminal save.
			this.onDeleteCallback?.(sessionId);
			await this.loadSessions();
		} catch (err) {
			console.error("Failed to delete session:", err);
			this.error = String(err);
		}
	}

	private handleSelect(sessionId: string) {
		if (this.onSelectCallback) {
			this.onSelectCallback(sessionId);
		}
		this.close();
	}

	private formatDate(isoString: string): string {
		const date = new Date(isoString);
		const now = new Date();
		const diff = now.getTime() - date.getTime();
		const days = Math.floor(diff / (1000 * 60 * 60 * 24));

		if (days === 0) {
			return i18n("Today");
		} else if (days === 1) {
			return i18n("Yesterday");
		} else if (days < 7) {
			return i18n("{days} days ago").replace("{days}", days.toString());
		} else {
			return date.toLocaleDateString();
		}
	}

	protected override renderContent() {
		return html`
			${DialogContent({
				className: "h-full flex flex-col",
				children: html`
					${DialogHeader({
						title: i18n("Sessions"),
						description: i18n("Load a previous conversation"),
					})}

					<label class="text-sm">Import conversation <input type="file" accept="application/json" @change=${(e: Event) => this.handleImport(e)} /></label>
					${this.error ? html`<p role="alert">${this.error}</p>` : ""}
					<div class="flex-1 overflow-y-auto mt-4 space-y-2">
						${
							this.loading
								? html`<div class="text-center py-8 text-muted-foreground">${i18n("Loading...")}</div>`
								: this.sessions.length === 0
									? html`<div class="text-center py-8 text-muted-foreground">${i18n("No sessions yet")}</div>`
									: this.sessions.map(
											(session) => html`
											<div
												class="group flex items-start gap-3 p-3 rounded-lg border border-border hover:bg-secondary/50 cursor-pointer transition-colors"
												@click=${() => this.handleSelect(session.id)}
											>
												<div class="flex-1 min-w-0">
													<div class="font-medium text-sm text-foreground truncate">${session.title}</div>
													<div class="text-xs text-muted-foreground mt-1">${this.formatDate(session.lastModified)}</div>
													<div class="text-xs text-muted-foreground mt-1">
														${validSessionMetadata(session)
															? html`${session.messageCount} ${i18n("messages")} · ${formatUsage(session.usage)}`
															: html`<span role="alert">Saved metadata is invalid; export this chat to repair it.</span>`}
													</div>
												</div>
												<button class="text-xs p-1" @click=${(e: Event) => this.handleExport(session.id, e)}>Export</button>
												<button
													class="opacity-0 group-hover:opacity-100 p-1 rounded hover:bg-destructive/10 text-destructive transition-opacity"
													@click=${(e: Event) => this.handleDelete(session.id, e)}
													title=${i18n("Delete")}
												>
													<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
														<path d="M3 6h18"></path>
														<path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"></path>
														<path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"></path>
													</svg>
												</button>
											</div>
										`,
										)
						}
					</div>
				`,
			})}
		`;
	}
}
