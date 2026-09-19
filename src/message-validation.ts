import { validImageBlocks } from "./attachment-limits.js";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { validUserMessage } from "./user-messages.js";
import { validRecallDelivery } from "./kg/recall-pool.js";

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const optionalString = (value: Record<string, unknown>, key: string) => value[key] === undefined || typeof value[key] === "string";
const tokenCount = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
/** Saved SDK usage has a cost breakdown object, including when every cost is zero. */
export function validSavedUsage(value: unknown): boolean {
  if (!record(value) || !record(value.cost)) return false;
  const cost = value.cost;
  return ["input", "output", "cacheRead", "cacheWrite", "totalTokens"].every(key => tokenCount(value[key])) &&
    ["reasoning", "cacheWrite1h"].every(key => value[key] === undefined || tokenCount(value[key])) &&
    ["input", "output", "cacheRead", "cacheWrite", "total"].every(key => typeof cost[key] === "number" && Number.isFinite(cost[key]) && (cost[key] as number) >= 0);
}
function validBlock(value: unknown, assistant: boolean): boolean {
  if (!record(value)) return false;
  switch (value.type) {
    case "text": return typeof value.text === "string" && optionalString(value, "textSignature");
    case "image": return !assistant; // Payload and aggregate limits are checked by validImageBlocks.
    case "thinking": return assistant && typeof value.thinking === "string" && optionalString(value, "thinkingSignature") &&
      (value.redacted === undefined || typeof value.redacted === "boolean");
    case "toolCall": return assistant && typeof value.id === "string" && typeof value.name === "string" && record(value.arguments) && optionalString(value, "thoughtSignature");
    default: return false;
  }
}

/** SDK content unions are role-specific; invalid evidence is rejected, never filtered or coerced. */
export function validMessageContent(value: unknown): boolean {
  if (!record(value) || typeof value.role !== "string") return false;
  if (value.role === "assistant" || value.role === "toolResult") {
    return Array.isArray(value.content) && validImageBlocks(value.content) && Array.from(value.content).every(block => validBlock(block, value.role === "assistant"));
  }
  if (value.role === "user" || value.role === "user-with-attachments") {
    return typeof value.content === "string" || Array.isArray(value.content) && validImageBlocks(value.content) && Array.from(value.content).every(block => validBlock(block, false));
  }
  return true; // App-specific roles have their own payloads, checked at the storage boundary.
}

export function assertMessageContent(value: unknown): void {
  if (!validMessageContent(value)) throw new Error("Invalid conversation message content; saved evidence is retained and must be repaired before loading");
}

/** Validate saved conversation payloads, including legacy records without optional transport metadata. */
export function validConversationMessage(value: unknown): value is AgentMessage {
  if (!record(value) || !validMessageContent(value)) return false;
  switch (value.role) {
    case "user": case "user-with-attachments": return validUserMessage(value as unknown as AgentMessage) &&
      (value.timestamp === undefined || typeof value.timestamp === "number" && Number.isFinite(value.timestamp));
    case "assistant": return ["api", "provider", "model", "responseModel", "responseId", "errorMessage"].every(key => optionalString(value, key)) &&
      (value.usage === undefined || validSavedUsage(value.usage)) &&
      (value.stopReason === undefined || ["stop", "length", "toolUse", "error", "aborted"].includes(value.stopReason as string)) &&
      (value.timestamp === undefined || typeof value.timestamp === "number" && Number.isFinite(value.timestamp));
    case "toolResult": return optionalString(value, "toolCallId") && optionalString(value, "toolName") &&
      (value.isError === undefined || typeof value.isError === "boolean") &&
      (value.timestamp === undefined || typeof value.timestamp === "number" && Number.isFinite(value.timestamp)) &&
      (value.addedToolNames === undefined || Array.isArray(value.addedToolNames) && value.addedToolNames.every(name => typeof name === "string"));
    case "memory-delivery": return validRecallDelivery(value.receipt) && typeof value.timestamp === "number" && Number.isFinite(value.timestamp);
    case "compactionSummary": return typeof value.summary === "string";
    case "memory-context": return typeof value.block === "string";
    case "system-notification": return typeof value.message === "string";
    case "voice-pending": return typeof value.timestamp === "string";
    case "corpus-ledger": return Array.isArray(value.entries) && value.entries.every(entry => record(entry) &&
      ["passage_id", "document_id", "source_revision", "extraction_revision", "title"].every(key => typeof entry[key] === "string") && optionalString(entry, "source_url") && optionalString(entry, "collection"));
    default: return false;
  }
}

export function assertConversationMessages(value: unknown): asserts value is AgentMessage[] {
  if (!Array.isArray(value) || !Array.from(value).every(validConversationMessage)) throw new Error("Invalid conversation messages; saved evidence is retained and must be repaired before loading");
}
