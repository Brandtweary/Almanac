import type { EvidenceRecord } from "./corpus-tools.js";
import { corpusLedgerContext } from "./corpus-ledger-context.js";
import type { RecallDelivery } from "./kg/recall-pool.js";
import type { CompactionSummaryMessage } from "@earendil-works/pi-agent-core";
import { COMPACTION_SUMMARY_PREFIX, COMPACTION_SUMMARY_SUFFIX } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import type { AgentMessage, MessageRenderer } from "./pi-web-ui/index.js";
import { defaultConvertToLlm, registerMessageRenderer } from "./pi-web-ui/index.js";
import { Alert } from "@mariozechner/mini-lit/dist/Alert.js";
import { html } from "lit";

// ============================================================================
// 1. EXTEND AppMessage TYPE VIA DECLARATION MERGING
// ============================================================================

// Define custom message types
export interface SystemNotificationMessage {
	role: "system-notification";
	message: string;
	variant: "default" | "destructive";
	timestamp: string;
}

// Legacy saved recall remains readable by audit tools but is excluded from
// model context; current recall is prepared independently for each request.
export interface MemoryContextMessage {
	role: "memory-context";
	block: string;
	timestamp: string;
}

export interface MemoryDeliveryMessage {
	role: "memory-delivery";
	receipt: RecallDelivery;
	timestamp: number;
}

// Recording-in-progress placeholder. Inserted on the user side at mic record-start
// and removed at record-stop (the real transcript bubble then lands via agent.prompt).
// Purely a visual cue — it carries no content and is deliberately given NO case in
// customConvertToLlm, so defaultConvertToLlm drops it (the model never sees it).
export interface VoicePendingMessage {
	role: "voice-pending";
	timestamp: string;
}

export interface CorpusLedgerMessage {
	role: "corpus-ledger";
	entries: EvidenceRecord[];
	timestamp: string;
}

// Extend CustomAgentMessages interface via declaration merging
// This must target pi-agent-core where CustomAgentMessages is defined.
// (compactionSummary is already declared by pi-agent-core's harness/messages; we only
// add a customConvertToLlm case for it below.)
declare module "@earendil-works/pi-agent-core" {
	interface CustomAgentMessages {
		"system-notification": SystemNotificationMessage;
		"memory-context": MemoryContextMessage;
		"memory-delivery": MemoryDeliveryMessage;
		"voice-pending": VoicePendingMessage;
		"corpus-ledger": CorpusLedgerMessage;
	}
}

export function createMemoryContextMessage(block: string): MemoryContextMessage {
	return { role: "memory-context", block, timestamp: new Date().toISOString() };
}

export function createVoicePendingMessage(): VoicePendingMessage {
	return { role: "voice-pending", timestamp: new Date().toISOString() };
}

// ============================================================================
// 2. CREATE CUSTOM RENDERER (TYPED TO SystemNotificationMessage)
// ============================================================================

const systemNotificationRenderer: MessageRenderer<SystemNotificationMessage> = {
	render: (notification) => {
		// notification is fully typed as SystemNotificationMessage!
		return html`
			<div class="px-4">
				${Alert({
					variant: notification.variant,
					children: html`
						<div class="flex flex-col gap-1">
							<div>${notification.message}</div>
							<div class="text-xs opacity-70">${new Date(notification.timestamp).toLocaleTimeString()}</div>
						</div>
					`,
				})}
			</div>
		`;
	},
};

// A user-side bubble (mirrors pi-web-ui's user-message markup) holding an
// undulating-ellipsis typing indicator — shown while the mic is recording.
const voicePendingRenderer: MessageRenderer<VoicePendingMessage> = {
	render: () => html`
		<div class="flex justify-start mx-4">
			<div class="user-message-container py-2 px-4 rounded-xl">
				<span class="cw-typing" aria-label="recording">
					<span></span><span></span><span></span>
				</span>
			</div>
		</div>
	`,
};

// ============================================================================
// 3. REGISTER RENDERER
// ============================================================================

export function registerCustomMessageRenderers() {
	registerMessageRenderer("system-notification", systemNotificationRenderer);
	registerMessageRenderer("voice-pending", voicePendingRenderer);
}

// ============================================================================
// 4. HELPER TO CREATE CUSTOM MESSAGES
// ============================================================================

export function createSystemNotification(
	message: string,
	variant: "default" | "destructive" = "default",
): SystemNotificationMessage {
	return {
		role: "system-notification",
		message,
		variant,
		timestamp: new Date().toISOString(),
	};
}

// ============================================================================
// 5. CUSTOM MESSAGE TRANSFORMER
// ============================================================================

/**
 * Custom message transformer that extends defaultConvertToLlm.
 * Handles system-notification messages by converting them to user messages.
 */
export function customConvertToLlm(messages: AgentMessage[]): Message[] {
	// First, handle our custom message types
	const processed = messages.filter(m => m.role !== "memory-delivery" && m.role !== "memory-context").map((m): AgentMessage => {
		if (m.role === "system-notification") {
			const notification = m as SystemNotificationMessage;
			// Convert to user message with <system> tags
			return {
				role: "user",
				content: `<system>${notification.message}</system>`,
				timestamp: Date.now(),
			};
		}
		if (m.role === "corpus-ledger") return { role: "user", content: corpusLedgerContext(), timestamp: Date.now() };
		if (m.role === "compactionSummary") {
			// History bounding: the compaction summary REPLACES the cut history.
			// defaultConvertToLlm drops this role, which would silently delete the
			// summarized turns — so wrap the summary in the canonical prefix/suffix
			// and surface it as a user message the model actually reads.
			const cs = m as CompactionSummaryMessage;
			return {
				role: "user",
				content: `${COMPACTION_SUMMARY_PREFIX}${cs.summary}${COMPACTION_SUMMARY_SUFFIX}`,
				timestamp: Date.now(),
			};
		}
		return m;
	});

	// Then use defaultConvertToLlm for standard handling
	return defaultConvertToLlm(processed);
}
