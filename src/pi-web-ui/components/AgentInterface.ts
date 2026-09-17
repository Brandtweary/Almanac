import { renderOnboarding } from "../../onboarding.js";
import { sendWithAdmission } from "../../send-admission.js";
import type { ToolResultMessage, Usage } from "@earendil-works/pi-ai";
import { streamSimple } from "../../pi-ai-slim-compat.js";
import { html, LitElement } from "lit";
import { customElement, property, query, state } from "lit/decorators.js";
import { ModelSelector } from "../dialogs/ModelSelector.js";
import type { MessageEditor } from "./MessageEditor.js";
import "./MessageEditor.js";
import "./MessageList.js";
import "./Messages.js"; // Import for side effects to register the custom elements
import { getAppStorage } from "../storage/app-storage.js";
import "./StreamingMessageContainer.js";
import type { Agent, AgentEvent, AgentMessage } from "@earendil-works/pi-agent-core";
import type { Attachment } from "../utils/attachment-types.js";
import { formatUsage } from "../utils/format.js";
import { i18n } from "../utils/i18n.js";
import { createStreamFn } from "../utils/proxy-utils.js";
import type { UserMessageWithAttachments } from "./Messages.js";
import type { StreamingMessageContainer } from "./StreamingMessageContainer.js";

@customElement("agent-interface")
export class AgentInterface extends LitElement {
	// Optional external session: when provided, this component becomes a view over the session
	@property({ attribute: false }) session?: Agent;
	@property({ type: Boolean }) sendDisabled = false;
	@property({ type: Boolean }) enableAttachments = true;
	@property({ type: Boolean }) enableModelSelector = true;
	@property({ type: Boolean }) enableThinkingSelector = true;
	@property({ type: Boolean }) showThemeToggle = false;
	// Optional custom API key prompt handler - if not provided, uses default dialog
	@property({ attribute: false }) onApiKeyRequired?: (provider: string) => Promise<boolean>;
	// Optional callback called before sending a message
	@property({ attribute: false }) onBeforeSend?: () => void | Promise<void>;
	// Optional callback called before executing a tool call - return false to prevent execution
	@property({ attribute: false }) onBeforeToolCall?: (toolName: string, args: any) => boolean | Promise<boolean>;
	// Optional callback called when cost display is clicked
	@property({ attribute: false }) onCostClick?: () => void;
	@property({ attribute: false }) getSourceMessages?: () => AgentMessage[];
	// Optional callback to override model selector behavior
	@property({ attribute: false }) onModelSelect?: () => void;

	// References
	@query("message-editor") private _messageEditor!: MessageEditor;
	@query("streaming-message-container") private _streamingContainer!: StreamingMessageContainer;

	private _autoScroll = true;
	private _sendingSessions = new WeakSet<Agent>();
	@state() private _sendError = "";
	@state() private _hasDraft = false;
	private _lastScrollTop = 0;
	private _lastClientHeight = 0;
	private _scrollContainer?: HTMLElement;
	private _resizeObserver?: ResizeObserver;
	private _unsubscribeSession?: () => void;
	// The committed message-list binds an identity-checked array prop, but agent-core
	// mutates state.messages IN PLACE — so a fresh render passing the same array
	// reference is skipped by Lit and the list goes stale. We keep our own clone,
	// re-taken only when a message is added or completed (see the session
	// subscription), giving Lit a new identity to react to. Per-token message_update
	// deliberately does NOT refresh this — the streaming container renders the live
	// message, and re-rendering the whole list per token would defeat that split.
	private _stableMessages: AgentMessage[] = [];
	private _sourceMessages: AgentMessage[] = [];

	private refreshStableMessages() {
		this._stableMessages = this.session ? [...this.session.state.messages] : [];
		this._sourceMessages = this.getSourceMessages?.() ?? [];
	}

	/** Re-sync the committed message list after an EXTERNAL edit to
	 *  session.state.messages — one the agent emits no lifecycle event for
	 *  (e.g. an injected placeholder bubble or a compaction rewrite). Agent-driven
	 *  changes (streaming, completion) refresh themselves via the subscription. */
	public refreshMessages() {
		this.refreshStableMessages();
		this.requestUpdate();
	}

	public setInput(text: string, attachments?: Attachment[]) {
		const update = () => {
			if (!this._messageEditor) requestAnimationFrame(update);
			else {
				this._messageEditor.value = text;
				this._messageEditor.attachments = attachments || [];
			}
		};
		update();
	}

	public setAutoScroll(enabled: boolean) {
		this._autoScroll = enabled;
	}

	protected override createRenderRoot(): HTMLElement | DocumentFragment {
		return this;
	}

	override willUpdate(changedProperties: Map<string, any>) {
		super.willUpdate(changedProperties);
		if (changedProperties.has("getSourceMessages")) this._sourceMessages = this.getSourceMessages?.() ?? [];

		// Re-subscribe when session property changes
		if (changedProperties.has("session")) {
			this._sendError = "";
			this.setupSessionSubscription();
		}
	}

	override async connectedCallback() {
		super.connectedCallback();

		this.style.display = "flex";
		this.style.flexDirection = "column";
		this.style.height = "100%";
		this.style.minHeight = "0";

		// Wait for first render to get scroll container
		await this.updateComplete;
		this._scrollContainer = this.querySelector(".overflow-y-auto") as HTMLElement;

		if (this._scrollContainer) {
			// Set up ResizeObserver to detect content changes
			this._resizeObserver = new ResizeObserver(() => {
				if (this._autoScroll && this._scrollContainer) {
					this._scrollContainer.scrollTop = this._scrollContainer.scrollHeight;
				}
			});

			// Observe the content container inside the scroll container
			const contentContainer = this._scrollContainer.querySelector(".max-w-3xl");
			if (contentContainer) {
				this._resizeObserver.observe(contentContainer);
			}

			// Set up scroll listener with better detection
			this._scrollContainer.addEventListener("scroll", this._handleScroll);
		}

		// Subscribe to external session if provided
		this.setupSessionSubscription();
	}

	override disconnectedCallback() {
		super.disconnectedCallback();

		// Clean up observers and listeners
		if (this._resizeObserver) {
			this._resizeObserver.disconnect();
			this._resizeObserver = undefined;
		}

		if (this._scrollContainer) {
			this._scrollContainer.removeEventListener("scroll", this._handleScroll);
		}

		if (this._unsubscribeSession) {
			this._unsubscribeSession();
			this._unsubscribeSession = undefined;
		}
	}

	private setupSessionSubscription() {
		if (this._unsubscribeSession) {
			this._unsubscribeSession();
			this._unsubscribeSession = undefined;
		}
		if (!this.session) return;
		this.refreshStableMessages();

		// Set default streamFn with proxy support if not already set
		if (this.session.streamFn === streamSimple) {
			this.session.streamFn = createStreamFn(async () => {
				const { enabled, url } = await getAppStorage().settings.getProxyConfig();
				return enabled ? url || undefined : undefined;
			});
		}

		// Set default getApiKey if not already set
		if (!this.session.getApiKey) {
			this.session.getApiKey = async (provider: string) => {
				const key = await getAppStorage().providerKeys.get(provider);
				return key ?? undefined;
			};
		}

		this._unsubscribeSession = this.session.subscribe(async (ev: AgentEvent) => {
			// Any event but a per-token stream delta means a message was added or
			// completed — re-clone so the committed list picks it up (see _stableMessages).
			if (ev.type !== "message_update") {
				this.refreshStableMessages();
			}
			switch (ev.type) {
				case "message_start":
				case "turn_start":
				case "turn_end":
				case "agent_start":
					this.requestUpdate();
					break;
				case "message_end":
					// Clear streaming container when a message completes
					// to prevent duplicate rendering (stable list now has this message)
					if (this._streamingContainer) {
						this._streamingContainer.setMessage(null, true);
					}
					this.requestUpdate();
					break;
				case "agent_end":
					// Clear streaming container when agent finishes
					if (this._streamingContainer) {
						this._streamingContainer.isStreaming = false;
						this._streamingContainer.setMessage(null, true);
					}
					this.requestUpdate();
					// finishRun() flips state.isStreaming=false AFTER agent_end with no
					// further event, so defer one more update to revert the editor's
					// stop button back to send.
					setTimeout(() => this.requestUpdate(), 0);
					break;
				case "message_update":
					if (this._streamingContainer) {
						const isStreaming = this.session?.state.isStreaming || false;
						this._streamingContainer.isStreaming = isStreaming;
						this._streamingContainer.setMessage(ev.message, !isStreaming);
					}
					this.requestUpdate();
					break;
			}
		});
	}

	private _handleScroll = (_ev: any) => {
		if (!this._scrollContainer) return;

		const currentScrollTop = this._scrollContainer.scrollTop;
		const scrollHeight = this._scrollContainer.scrollHeight;
		const clientHeight = this._scrollContainer.clientHeight;
		const distanceFromBottom = scrollHeight - currentScrollTop - clientHeight;

		// Ignore relayout due to message editor getting pushed up by stats
		if (clientHeight < this._lastClientHeight) {
			this._lastClientHeight = clientHeight;
			return;
		}

		// Only disable auto-scroll if user scrolled UP or is far from bottom
		if (currentScrollTop !== 0 && currentScrollTop < this._lastScrollTop && distanceFromBottom > 50) {
			this._autoScroll = false;
		} else if (distanceFromBottom < 10) {
			// Re-enable if very close to bottom
			this._autoScroll = true;
		}

		this._lastScrollTop = currentScrollTop;
		this._lastClientHeight = clientHeight;
	};

	public async sendMessage(input: string, attachments?: Attachment[]) {
		if (this.sendDisabled) return;
		const submittedAttachments = attachments ? [...attachments] : [];
		if (!input.trim() && submittedAttachments.length === 0) return;
		const session = this.session;
		if (!session) throw new Error("No session set on AgentInterface");
		if (!session.state.model) throw new Error("No model set on AgentInterface");
		if (session.state.isStreaming || this._sendingSessions.has(session)) return;
		this._sendingSessions.add(session);
		this.requestUpdate();
		this._sendError = "";
		const editor = this._messageEditor;
		const isCurrent = () => this.session === session && !session.state.isStreaming && !this.sendDisabled;
		try {
			const provider = session.state.model.provider;
			const apiKey = await getAppStorage().providerKeys.get(provider);
			if (!isCurrent()) return;
			if (!apiKey) {
				if (!this.onApiKeyRequired) {
					console.error("No API key configured and no onApiKeyRequired handler set");
					return;
				}
				const success = await this.onApiKeyRequired(provider);
				if (!isCurrent() || !success) return;
			}
			if (this.onBeforeSend) {
				await this.onBeforeSend();
				if (!isCurrent()) return;
			}

			// Admission may await storage, tokenization or context preparation inside
			// prompt(). Keep the draft until this exact user message is accepted.
			const clearSubmittedDraft = () => {
				if (this.session === session && !this.sendDisabled && editor &&
					this._messageEditor === editor && editor.value === input &&
					editor.attachments.length === submittedAttachments.length &&
					editor.attachments.every((attachment, i) => attachment === submittedAttachments[i])) {
					editor.value = "";
					editor.attachments = [];
				}
			};
			const message: AgentMessage = submittedAttachments.length > 0
				? { role: "user-with-attachments", content: input, attachments: submittedAttachments, timestamp: Date.now() } satisfies UserMessageWithAttachments
				: { role: "user", content: input, timestamp: Date.now() };
			this._autoScroll = true;
			await sendWithAdmission(session, message, clearSubmittedDraft);
		} catch (error) {
			if (this.session === session && !this.sendDisabled) this._sendError = `Message could not be sent: ${error instanceof Error ? error.message : String(error)}`;
			throw error;
		} finally {
			this._sendingSessions.delete(session);
			this.requestUpdate();
		}
	}

	private renderMessages() {
		if (!this.session)
			return html`<div class="p-4 text-center text-muted-foreground">${i18n("No session available")}</div>`;
		const state = this.session.state;
		const showWelcome = !state.isStreaming && !this.sendDisabled && !this._sendingSessions.has(this.session) &&
			!state.messages.some(message => ["user", "user-with-attachments", "assistant", "voice-pending", "compactionSummary"].includes(message.role));
		// Build a map of tool results to allow inline rendering in assistant messages
		const toolResultsById = new Map<string, ToolResultMessage<any>>();
		for (const message of state.messages) {
			if (message.role === "toolResult") {
				toolResultsById.set(message.toolCallId, message);
			}
		}
		return html`
			<div class="flex flex-col gap-3">
				${showWelcome ? renderOnboarding(this._hasDraft, text => {
					if (!this.sendDisabled && !state.isStreaming && !this._sendingSessions.has(this.session!)) this._messageEditor?.insertSuggestion(text);
				}) : ""}
				<!-- Stable messages list - won't re-render during streaming -->
				<message-list
					.messages=${this._stableMessages}
					.sourceMessages=${this._sourceMessages}
					.tools=${state.tools}
					.pendingToolCalls=${this.session ? this.session.state.pendingToolCalls : new Set<string>()}
					.isStreaming=${state.isStreaming}
					.onCostClick=${this.onCostClick}
				></message-list>

				<!-- Streaming message container - manages its own updates -->
				<streaming-message-container
					class="${state.isStreaming ? "" : "hidden"}"
					.tools=${state.tools}
					.isStreaming=${state.isStreaming}
					.pendingToolCalls=${state.pendingToolCalls}
					.toolResultsById=${toolResultsById}
					.onCostClick=${this.onCostClick}
				></streaming-message-container>
			</div>
		`;
	}

	private renderStats() {
		if (!this.session) return html`<div class="text-xs h-5"></div>`;

		const state = this.session.state;
		const totals = state.messages
			.filter((m) => m.role === "assistant")
			.reduce(
				(acc, msg: any) => {
					const usage = msg.usage;
					if (usage) {
						acc.input += usage.input;
						acc.output += usage.output;
						acc.cacheRead += usage.cacheRead;
						acc.cacheWrite += usage.cacheWrite;
						acc.cost.total += usage.cost.total;
					}
					return acc;
				},
				{
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				} satisfies Usage,
			);

		const hasTotals = totals.input || totals.output || totals.cacheRead || totals.cacheWrite;
		const totalsText = hasTotals ? formatUsage(totals) : "";

		return html`
			<div class="text-xs text-muted-foreground flex justify-between items-center h-5">
				<div class="flex items-center gap-1">
					${this.showThemeToggle ? html`<theme-toggle></theme-toggle>` : html``}
				</div>
				<div class="flex ml-auto items-center gap-3">
					${
						totalsText
							? this.onCostClick
								? html`<span class="cursor-pointer hover:text-foreground transition-colors" @click=${this.onCostClick}>${totalsText}</span>`
								: html`<span>${totalsText}</span>`
							: ""
					}
				</div>
			</div>
		`;
	}

	override render() {
		if (!this.session)
			return html`<div class="p-4 text-center text-muted-foreground">${i18n("No session set")}</div>`;

		const session = this.session;
		const state = this.session.state;
		return html`
			<div class="flex flex-col h-full bg-background text-foreground">
				<!-- Messages Area -->
				<div class="flex-1 overflow-y-auto">
					<div class="max-w-3xl mx-auto p-4 pb-0">${this.renderMessages()}</div>
				</div>

				<!-- Input Area -->
				<div class="shrink-0">
					<div class="max-w-3xl mx-auto px-2">
						${this._sendError ? html`<div role="alert" class="text-sm text-red-500 py-2">${this._sendError}</div>` : ""}
						<message-editor
							@composer-draft-change=${(event: CustomEvent<boolean>) => { this._hasDraft = event.detail; }}
							.disabled=${this.sendDisabled}
							.isStreaming=${state.isStreaming}
							.currentModel=${state.model}
							.thinkingLevel=${state.thinkingLevel}
							.showAttachmentButton=${this.enableAttachments}
							.showModelSelector=${this.enableModelSelector}
							.showThinkingSelector=${this.enableThinkingSelector}
							.onSend=${(input: string, attachments: Attachment[]) => {
								void this.sendMessage(input, attachments).catch(() => {});
							}}
							.onAbort=${() => session.abort()}
							.onModelSelect=${() => {
								if (this.onModelSelect) {
									this.onModelSelect();
								} else {
									ModelSelector.open(state.model, (model) => {
										session.state.model = model;
									});
								}
							}}
							.onThinkingChange=${
								this.enableThinkingSelector
									? (level: "off" | "minimal" | "low" | "medium" | "high") => {
											session.state.thinkingLevel = level;
										}
									: undefined
							}
						></message-editor>
						${this.renderStats()}
					</div>
				</div>
			</div>
		`;
	}
}

// Register custom element with guard
if (!customElements.get("agent-interface")) {
	customElements.define("agent-interface", AgentInterface);
}
