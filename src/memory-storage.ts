import { appendMemoryArchive, clearMemoryArchive, readMemoryArchive, type MemoryArchiveRecord, type MemoryArchiveQuery, type MemoryArchivePage } from "./memory-archive.js";
import type { GraphAsset } from "./kg/types.js";
import type { PipelineRuntime } from "./pipeline.js";
import type { StorageBackend, StorageTransaction } from "./pi-web-ui/storage/types.js";

export type StoredValue = { present: false } | { present: true; value: unknown };
export const LEGACY_PIPELINE_KEYS = ["buffers", "stt-lexicon", "flags", "running-context"] as const;
const STORES = ["lexicon", "pipeline", "memory-consent"];
const REVISION_KEY = "revision";

export interface MemorySnapshot {
	revision: number;
	graph: StoredValue;
	pipeline: StoredValue;
	legacyPipeline: Record<(typeof LEGACY_PIPELINE_KEYS)[number], StoredValue>;
	consent: StoredValue;
}

export interface MemoryUpdate {
	graph?: GraphAsset;
	pipeline?: ReturnType<PipelineRuntime["snapshot"]>;
	consent?: "granted" | "declined";
	archive?: MemoryArchiveRecord[];
	clearArchive?: boolean;
}

export class MemoryStorageConflictError extends Error {
	constructor() {
		super("Personal memory changed in another tab. Reload this page before saving memory; your saved data has not been overwritten.");
		this.name = "MemoryStorageConflictError";
	}
}

async function readValue(tx: StorageTransaction, store: string, key: string): Promise<StoredValue> {
	return await tx.has(store, key) ? { present: true, value: await tx.get(store, key) } : { present: false };
}

async function readRevision(tx: StorageTransaction): Promise<number> {
	const row = await readValue(tx, "pipeline", REVISION_KEY);
	if (!row.present) return 0;
	if (typeof row.value !== "number" || !Number.isSafeInteger(row.value) || row.value < 0) {
		throw new Error("Invalid saved memory revision. Saved data is retained; reload after repairing storage.");
	}
	return row.value;
}

/** One page's write authority over personal memory, including its consent state. */
export class MemoryStorage {
	private revision: number | null = null;
	private tail: Promise<unknown> = Promise.resolve();
	invalidated = false;

	constructor(private backend: Pick<StorageBackend, "transaction">) {}

	private ordered<T>(operation: () => Promise<T>): Promise<T> {
		const result = this.tail.then(operation);
		this.tail = result.catch(() => undefined);
		return result;
	}

	load(): Promise<MemorySnapshot> {
		return this.ordered(async () => {
			this.revision = null;
			const snapshot = await this.backend.transaction(STORES, "readonly", async (tx) => {
				const revision = await readRevision(tx);
				const graph = await readValue(tx, "lexicon", "terms");
				const pipeline = await readValue(tx, "pipeline", "state");
				const consent = await readValue(tx, "memory-consent", "choice");
				const legacyPipeline = {} as MemorySnapshot["legacyPipeline"];
				for (const key of LEGACY_PIPELINE_KEYS) legacyPipeline[key] = await readValue(tx, "pipeline", key);
				return { revision, graph, pipeline, legacyPipeline, consent };
			});
			this.revision = snapshot.revision;
			this.invalidated = false;
			return snapshot;
		});
	}

	readArchive(query: MemoryArchiveQuery = {}, assertActive?: () => void): Promise<MemoryArchivePage> {
		return this.ordered(() => this.backend.transaction(STORES, "readonly", async tx => {
			assertActive?.();
			if (this.invalidated || this.revision === null || await readRevision(tx) !== this.revision) { this.invalidated = true; throw new MemoryStorageConflictError(); }
			const page = await readMemoryArchive(tx, query);
			assertActive?.();
			return page;
		}));
	}

	/** Export a consistent persisted snapshot, not independently sampled live UI objects. */
	exportData(): Promise<{ graph: StoredValue; pipeline: StoredValue; legacyPipeline: MemorySnapshot["legacyPipeline"]; archive: MemoryArchiveRecord[] }> {
		return this.ordered(() => this.backend.transaction(STORES, "readonly", async tx => {
			if (this.invalidated || this.revision === null || await readRevision(tx) !== this.revision) { this.invalidated = true; throw new MemoryStorageConflictError(); }
			const graph = await readValue(tx, "lexicon", "terms");
			const pipeline = await readValue(tx, "pipeline", "state");
			const legacyPipeline = {} as MemorySnapshot["legacyPipeline"];
			for (const key of LEGACY_PIPELINE_KEYS) legacyPipeline[key] = await readValue(tx, "pipeline", key);
			const archive: MemoryArchiveRecord[] = [];
			let cursor: string | undefined;
			do {
				const page = await readMemoryArchive(tx, { cursor, limit: 100 });
				archive.push(...page.records);
				cursor = page.next ?? undefined;
			} while (cursor !== undefined);
			return { graph, pipeline, legacyPipeline, archive };
		}));
	}

	async save(update: MemoryUpdate, assertActive?: () => void): Promise<void> {
		// Clone before entering the async queue: graph serialization may share live
		// rows, and a later turn must not mutate an already-submitted publication.
		const frozen = structuredClone(update);
		const fields = Object.keys(frozen);
		if (!fields.length) return;
		if (fields.some((field) => !["graph", "pipeline", "consent", "archive", "clearArchive"].includes(field)) ||
			fields.some((field) => frozen[field as keyof MemoryUpdate] === undefined)) {
			throw new Error("Invalid memory update");
		}
		if ("clearArchive" in frozen && typeof frozen.clearArchive !== "boolean") throw new Error("Invalid archive replacement request");
		if ("consent" in frozen && frozen.consent !== "granted" && frozen.consent !== "declined") {
			throw new Error("Invalid memory consent");
		}
		return this.ordered(async () => {
			if (this.invalidated) throw new MemoryStorageConflictError();
			if (this.revision === null) throw new Error("Memory has not loaded. Reload before saving personal memory.");
			try {
				const next = await this.backend.transaction(STORES, "readwrite", async (tx) => {
					assertActive?.();
					const current = await readRevision(tx);
					if (current !== this.revision) throw new MemoryStorageConflictError();
					if (current === Number.MAX_SAFE_INTEGER) throw new Error("Memory revision limit reached; saved data is retained.");
					if (frozen.clearArchive === true) await clearMemoryArchive(tx);
					if (frozen.archive !== undefined) {
						if (!Array.isArray(frozen.archive)) throw new Error("Invalid memory archive update");
						await appendMemoryArchive(tx, frozen.archive);
					}
					if ("graph" in frozen) await tx.set("lexicon", "terms", frozen.graph);
					if ("pipeline" in frozen) {
						await tx.set("pipeline", "state", frozen.pipeline);
						for (const key of LEGACY_PIPELINE_KEYS) await tx.delete("pipeline", key);
					}
					if ("consent" in frozen) await tx.set("memory-consent", "choice", frozen.consent);
					assertActive?.();
					await tx.set("pipeline", REVISION_KEY, current + 1);
					return current + 1;
				});
				this.revision = next;
			} catch (error) {
				if (error instanceof MemoryStorageConflictError) this.invalidated = true;
				throw error;
			}
		});
	}
}
