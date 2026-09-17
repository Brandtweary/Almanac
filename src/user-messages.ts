import { validAttachments, base64Bytes, MAX_ATTACHMENTS } from "./attachment-limits.js";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { UserMessageWithAttachments } from "./pi-web-ui/components/Messages.js";

export function isUserMessage(message: AgentMessage): message is Extract<AgentMessage, { role: "user" }> | UserMessageWithAttachments {
  return message.role === "user" || message.role === "user-with-attachments";
}

/** Uploaded source text is distinct from the user's own accompanying statement. */
export function userStatementText(message: AgentMessage): string {
  if (!isUserMessage(message)) return "";
  return typeof message.content === "string" ? message.content : message.content.filter(block => block.type === "text").map(block => block.text).join(" ");
}

export function validUserMessage(message: AgentMessage): boolean {
  if (!isUserMessage(message) || !(typeof message.content === "string" || Array.isArray(message.content))) return false;
  if (Array.isArray(message.content) && !message.content.every(block => block &&
    (block.type === "text" ? typeof block.text === "string" : block.type === "image" && base64Bytes(block.data) !== null && typeof block.mimeType === "string"))) return false;
  if (Array.isArray(message.content) && message.content.filter(block => block.type === "image").length > MAX_ATTACHMENTS) return false;
  if (message.role === "user" || message.attachments === undefined) return true;
  return validAttachments(message.attachments);
}
