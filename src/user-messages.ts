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
    (block.type === "text" ? typeof block.text === "string" : block.type === "image" && typeof block.data === "string" && typeof block.mimeType === "string"))) return false;
  if (message.role === "user" || message.attachments === undefined) return true;
  return Array.isArray(message.attachments) && message.attachments.every(a => a &&
    (a.type === "image" || a.type === "document") && [a.id, a.fileName, a.mimeType, a.content].every(value => typeof value === "string") &&
    Number.isFinite(a.size) && a.size >= 0 && (a.extractedText === undefined || typeof a.extractedText === "string") &&
    (a.preview === undefined || typeof a.preview === "string"));
}
