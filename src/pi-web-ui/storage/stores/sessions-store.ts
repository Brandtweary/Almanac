import { isOfficeArchive } from "../../../attachment-limits.js";
import { assertConversationMessages, validSavedUsage } from "../../../message-validation.js";
import { ConversationHistory } from "../../../conversation-history.js";
import type { AgentState } from "@earendil-works/pi-agent-core";
import { Store } from "../store.js";
import type { SessionData, SessionMetadata, StoreConfig } from "../types.js";

function assertMetadata(value: unknown): asserts value is SessionMetadata {
	const row = value as SessionMetadata | null;
	if (!row || typeof row !== "object" || [row.id, row.title, row.preview].some(text => typeof text !== "string") ||
		[row.createdAt, row.lastModified].some(date => typeof date !== "string" || !Number.isFinite(Date.parse(date))) ||
		!Number.isSafeInteger(row.messageCount) || row.messageCount < 0 || !validSavedUsage(row.usage) ||
		!["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(row.thinkingLevel)) {
		throw new Error("Invalid conversation metadata; saved data is retained and must be repaired before loading");
	}
}

/** List views retain damaged records so their original export remains reachable. */
export function validSessionMetadata(value: unknown): value is SessionMetadata {
	try { assertMetadata(value); return true; } catch { return false; }
}

function assertSessionData(value: unknown): asserts value is SessionData {
	const row = value as SessionData | null;
	if (!row || typeof row !== "object" || typeof row.id !== "string" || typeof row.title !== "string" ||
		!row.model || typeof row.model.id !== "string" || !["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(row.thinkingLevel) ||
		[row.createdAt, row.lastModified].some(date => typeof date !== "string" || !Number.isFinite(Date.parse(date))) ||
		(row.revision !== undefined && (!Number.isSafeInteger(row.revision) || row.revision < 0))) {
		throw new Error("Invalid conversation data; saved evidence is retained and must be repaired before loading");
	}
	assertConversationMessages(row.messages);
	new ConversationHistory(row.rawHistory, row.messages);
}

/**
 * Store for chat sessions (data and metadata).
 * Uses two object stores: sessions (full data) and sessions-metadata (lightweight).
 */
export class SessionsStore extends Store {
	getConfig(): StoreConfig {
		return {
			name: "sessions",
			keyPath: "id",
			indices: [{ name: "lastModified", keyPath: "lastModified" }],
		};
	}

	/**
	 * Additional config for sessions-metadata store.
	 * Must be included when creating the backend.
	 */
	static getMetadataConfig(): StoreConfig {
		return {
			name: "sessions-metadata",
			keyPath: "id",
			indices: [{ name: "lastModified", keyPath: "lastModified" }],
		};
	}

	async save(data: SessionData, metadata: SessionMetadata, expectedRevision?: number): Promise<void> {
		assertSessionData(data);
		assertMetadata(metadata);
		await this.getBackend().transaction(["sessions", "sessions-metadata"], "readwrite", async (tx) => {
			const existing = await tx.get<SessionData>("sessions", data.id);
			if (expectedRevision !== undefined && (existing ? existing.revision ?? 0 : -1) !== expectedRevision) throw new Error("Conversation changed in another tab or was deleted; reload before saving");
			await tx.set("sessions", data.id, { ...data, revision: (existing?.revision ?? 0) + 1 });
			await tx.set("sessions-metadata", metadata.id, metadata);
		});
	}

	async exportSession(id: string): Promise<string> {
		return this.getBackend().transaction(["sessions", "sessions-metadata"], "readonly", async tx => {
			const session = await tx.get<SessionData>("sessions", id);
			const metadata = await tx.get<SessionMetadata>("sessions-metadata", id);
			if (!session || !metadata) throw new Error("Conversation no longer exists");
			return JSON.stringify({ format: "almanac-conversation", version: 1, session, metadata });
		});
	}

	async importSession(text: string): Promise<string> {
		const value = JSON.parse(text);
		const data = value?.session;
		const meta = value?.metadata;
		if (value?.format !== "almanac-conversation" || value.version !== 1 || !data || !meta ||
			typeof data.title !== "string" || !Array.isArray(data.messages) || !data.model || typeof data.model.id !== "string" ||
			typeof data.createdAt !== "string" || !Number.isFinite(Date.parse(data.createdAt))) throw new Error("Invalid conversation export");
		assertSessionData(data);
		assertMetadata(meta);
		const archive = new ConversationHistory(data.rawHistory, data.messages).snapshot();
		const checked = new Set<string>();
		for (const message of [...data.messages, ...archive.records.map(record => record.message)]) {
			if (message.role !== "user-with-attachments") continue;
			for (const attachment of message.attachments ?? []) {
				const office = isOfficeArchive(attachment.fileName, attachment.mimeType);
				const legacy = attachment.fileName.toLowerCase().endsWith(".xls");
				const checkKey = `${office}:${legacy}:${attachment.content}`;
				if ((!office && !attachment.content.startsWith("UEs")) || checked.has(checkKey)) continue;
				checked.add(checkKey);
				const { assertDocumentBudget } = await import("../../utils/document-budget.js");
				await assertDocumentBudget(Uint8Array.from(atob(attachment.content), char => char.charCodeAt(0)).buffer, office, legacy);
			}
		}

		const id = crypto.randomUUID();
		const lastModified = new Date().toISOString();
		await this.save({ ...data, id, rawHistory: archive, revision: undefined, lastModified },
			{ ...meta, id, title: data.title, createdAt: data.createdAt, lastModified, messageCount: data.messages.length }, -1);
		return id;
	}

	async get(id: string): Promise<SessionData | null> {
		const data = await this.getBackend().get<SessionData>("sessions", id);
		if (data !== null) assertSessionData(data);
		return data;
	}

	async getMetadata(id: string): Promise<SessionMetadata | null> {
		const metadata = await this.getBackend().get<SessionMetadata>("sessions-metadata", id);
		if (metadata !== null) assertMetadata(metadata);
		return metadata;
	}

	async getAllMetadata(): Promise<SessionMetadata[]> {
		// Use the lastModified index to get sessions sorted by most recent first
		return this.getBackend().getAllFromIndex<SessionMetadata>("sessions-metadata", "lastModified", "desc");
	}

	async delete(id: string): Promise<void> {
		await this.getBackend().transaction(["sessions", "sessions-metadata"], "readwrite", async (tx) => {
			await tx.delete("sessions", id);
			await tx.delete("sessions-metadata", id);
		});
	}

	// Alias for backward compatibility
	async deleteSession(id: string): Promise<void> {
		return this.delete(id);
	}

	async updateTitle(id: string, title: string, expectedRevision?: number): Promise<number> {
		return this.getBackend().transaction(["sessions", "sessions-metadata"], "readwrite", async tx => {
			const data = await tx.get<SessionData>("sessions", id);
			const metadata = await tx.get<SessionMetadata>("sessions-metadata", id);
			if (!data || !metadata) throw new Error("Conversation was deleted; reload before renaming");
			if (expectedRevision !== undefined && (data.revision ?? 0) !== expectedRevision) throw new Error("Conversation changed in another tab; reload before renaming");
			const revision = (data.revision ?? 0) + 1;
			await tx.set("sessions", id, { ...data, title, revision });
			await tx.set("sessions-metadata", id, { ...metadata, title });
			return revision;
		});
	}

	async getQuotaInfo(): Promise<{ usage: number; quota: number; percent: number }> {
		return this.getBackend().getQuotaInfo();
	}

	async requestPersistence(): Promise<boolean> {
		return this.getBackend().requestPersistence();
	}

	// Alias methods for backward compatibility
	async saveSession(
		id: string,
		state: AgentState,
		metadata: SessionMetadata | undefined,
		title?: string,
	): Promise<void> {
		// If metadata is provided, use it; otherwise create it from state
		const meta: SessionMetadata = metadata || {
			id,
			title: title || "",
			createdAt: new Date().toISOString(),
			lastModified: new Date().toISOString(),
			messageCount: state.messages?.length || 0,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			thinkingLevel: state.thinkingLevel || "off",
			preview: "",
		};

		const data: SessionData = {
			id,
			title: title || meta.title,
			model: state.model,
			thinkingLevel: state.thinkingLevel,
			messages: state.messages || [],
			createdAt: meta.createdAt,
			lastModified: new Date().toISOString(),
		};

		await this.save(data, meta);
	}

	async loadSession(id: string): Promise<SessionData | null> {
		return this.get(id);
	}

	async getLatestSessionId(): Promise<string | null> {
		const allMetadata = await this.getAllMetadata();
		if (allMetadata.length === 0) return null;

		// Sort by lastModified descending
		allMetadata.sort((a, b) => b.lastModified.localeCompare(a.lastModified));
		return allMetadata[0].id;
	}
}
