import type { Attachment } from "./pi-web-ui/utils/attachment-types.js";
export const MAX_ATTACHMENTS = 10;
export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
export const MAX_ATTACHMENT_TOTAL_BYTES = MAX_ATTACHMENTS * MAX_ATTACHMENT_BYTES;
export const MAX_EXTRACTED_TEXT_BYTES = 20 * 1024 * 1024;
export const MAX_DOCUMENT_EXPANSION_BYTES = 40 * 1024 * 1024;

/** Validate encoded size and canonical padding without allocating decoded payloads. */
export function base64Bytes(value: unknown, limit = MAX_ATTACHMENT_BYTES): number | null {
	if (typeof value !== "string" || value.length > 4 * Math.ceil(limit / 3) || value.length % 4) return null;
	// Scan by bounded quartets; a whole-payload regexp can exhaust the engine stack.
	const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
	const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
	for (let i = 0; i < value.length - padding; i++) if (!alphabet.includes(value[i])) return null;
	if (padding && (value.length === 0 || alphabet.indexOf(value[value.length - padding - 1]) % (padding === 2 ? 16 : 4))) return null;
	const size = value.length / 4 * 3 - padding;
	return size <= limit ? size : null;
}

export function validAttachments(value: unknown): value is Attachment[] {
	if (!Array.isArray(value) || value.length > MAX_ATTACHMENTS) return false;
	let total = 0;
	for (const a of value) {
		if (!a || (a.type !== "image" && a.type !== "document") ||
			![a.id, a.fileName, a.mimeType].every(v => typeof v === "string" && v.length <= 4096) ||
			!Number.isSafeInteger(a.size) || a.size < 0 || a.size > MAX_ATTACHMENT_BYTES || base64Bytes(a.content) !== a.size) return false;
		const previewSize = a.preview === undefined ? 0 : base64Bytes(a.preview);
		if (previewSize === null) return false;
		if (a.extractedText !== undefined && (typeof a.extractedText !== "string" || a.extractedText.length > MAX_EXTRACTED_TEXT_BYTES || new TextEncoder().encode(a.extractedText).length > MAX_EXTRACTED_TEXT_BYTES)) return false;
		total += a.size + previewSize + (a.extractedText === undefined ? 0 : new TextEncoder().encode(a.extractedText).length);
		if (total > MAX_ATTACHMENT_TOTAL_BYTES) return false;
	}
	return true;
}

export function isOfficeArchive(fileName: string, mimeType: string): boolean {
	return /\.(?:docx|xlsx|pptx)$/i.test(fileName) || mimeType.includes("officedocument.");
}
