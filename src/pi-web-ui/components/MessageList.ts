import { collectAnswerSources, answerCopyText, answerIdentity, answerText, isAnswerMessage } from "../../answer-sources.js";
import { EvidenceLedger } from "../../corpus-tools.js";
import { renderAnswerSources } from "./AnswerSources.js";
import "./AnswerControls.js";
import type { AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import type {
	AssistantMessage as AssistantMessageType,
	ToolResultMessage as ToolResultMessageType,
} from "@earendil-works/pi-ai";
import { html, LitElement, nothing, type TemplateResult } from "lit";
import { property } from "lit/decorators.js";
import { repeat } from "lit/directives/repeat.js";
import { renderMessage } from "./message-renderer-registry.js";

export class MessageList extends LitElement {
	@property({ type: Array }) messages: AgentMessage[] = [];
	@property({ type: Array }) sourceMessages: AgentMessage[] = [];
	@property({ type: Array }) tools: AgentTool[] = [];
	@property({ type: Object }) pendingToolCalls?: ReadonlySet<string>;
	@property({ type: Boolean }) isStreaming: boolean = false;
	@property({ attribute: false }) onCostClick?: () => void;

	protected override createRenderRoot(): HTMLElement | DocumentFragment {
		return this;
	}

	override connectedCallback(): void {
		super.connectedCallback();
		this.style.display = "block";
	}

	private buildRenderItems() {
		const currentSources = collectAnswerSources(this.messages);
		const archivedSources = collectAnswerSources(this.sourceMessages);
		// Copied text resolves citation handles against every passage this conversation has seen,
		// including the raw archive a compaction rewrote out of the live history.
		const ledger = new EvidenceLedger();
		ledger.restore([...this.sourceMessages, ...this.messages]);
		// Map tool results by call id for quick lookup
		const resultByCallId = new Map<string, ToolResultMessageType>();
		for (const message of this.messages) {
			if (message.role === "toolResult") {
				resultByCallId.set(message.toolCallId, message);
			}
		}

		const items: Array<{ key: string; template: TemplateResult }> = [];
		let index = 0;
		for (const msg of this.messages) {
			// Skip artifact messages - they're for session persistence only, not UI display
			if (msg.role === "artifact") {
				continue;
			}

			// Try custom renderer first
			const customTemplate = renderMessage(msg);
			if (customTemplate) {
				items.push({ key: `msg:${index}`, template: customTemplate });
				index++;
				continue;
			}

			// Fall back to built-in renderers
			if (msg.role === "user" || msg.role === "user-with-attachments") {
				items.push({
					key: `msg:${index}`,
					template: html`<user-message .message=${msg}></user-message>`,
				});
				index++;
			} else if (msg.role === "assistant") {
				const amsg = msg as AssistantMessageType;
				const evidence = archivedSources.get(answerIdentity(amsg)) ?? currentSources.get(answerIdentity(amsg));
				items.push({
					key: `msg:${index}`,
					template: html`<assistant-message
						.message=${amsg}
						.tools=${this.tools}
						.isStreaming=${false}
						.pendingToolCalls=${this.pendingToolCalls}
						.toolResultsById=${resultByCallId}
						.hideToolCalls=${false}
						.hidePendingToolCalls=${this.isStreaming}
						.onCostClick=${this.onCostClick}
					></assistant-message>${renderAnswerSources(evidence)}${isAnswerMessage(amsg)
						? html`<answer-controls
								.answerKey=${answerIdentity(amsg)}
								.copyText=${answerCopyText(amsg, evidence, ledger)}
								.speechText=${answerText(amsg)}
							></answer-controls>`
						: nothing}`,
				});
				index++;
			} else {
				// Skip standalone toolResult messages; they are rendered via paired tool-message above
				// Skip unknown roles
			}
		}
		return items;
	}

	override render() {
		const items = this.buildRenderItems();
		return html`<div class="flex flex-col gap-3">
			${repeat(
				items,
				(it) => it.key,
				(it) => it.template,
			)}
		</div>`;
	}
}

// Register custom element
if (!customElements.get("message-list")) {
	customElements.define("message-list", MessageList);
}
