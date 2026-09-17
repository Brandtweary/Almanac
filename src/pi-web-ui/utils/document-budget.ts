import JSZip from "jszip";
import { MAX_DOCUMENT_EXPANSION_BYTES } from "../../attachment-limits.js";

/** Bound actual ZIP expansion before passing compressed Office content to a parser. */
export async function assertDocumentBudget(bytes: ArrayBuffer, required = false, allowLegacySpreadsheet = false): Promise<void> {
	const prefix = new Uint8Array(bytes, 0, Math.min(8, bytes.byteLength));
	// Legacy .xls records may carry the OOXML MIME type. Only an actual compound
	// document signature permits that compatibility path; a renamed ZIP stays bounded.
	if (allowLegacySpreadsheet && [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1].every((byte, index) => prefix[index] === byte)) return;
	if (!required && (prefix[0] !== 0x50 || prefix[1] !== 0x4b)) return;
	const zip = await JSZip.loadAsync(bytes);
	const entries = Object.values(zip.files);
	if (entries.length > 10000) throw new Error("Document contains too many archive entries");
	let total = 0;
	for (const entry of entries) {
		if (entry.dir) continue;
		await new Promise<void>((resolve, reject) => {
			const stream = (entry as unknown as { internalStream(type: "uint8array"): { on(event: string, callback: (...args: any[]) => void): void; pause(): void; resume(): void } }).internalStream("uint8array");
			stream.on("data", (data: Uint8Array) => {
				total += data.byteLength;
				if (total > MAX_DOCUMENT_EXPANSION_BYTES) { stream.pause(); reject(new Error("Document expansion exceeds the preview limit")); }
			});
			stream.on("error", reject); stream.on("end", resolve); stream.resume();
		});
	}
}
