import type { StorageTransaction } from "./pi-web-ui/storage/types.js";

export interface MemoryArchiveRecord {
  version: 1;
  id: string;
  jobId: string;
  sessionKey: string;
  role: "audit" | "memory" | "summary";
  attempt: string;
  sequence: number;
  kind: "request" | "message" | "tool" | "outcome" | "actions" | "summary";
  status: "transient" | "complete" | "failed" | "cancelled";
  model: { id: string; profile?: string };
  createdAt: string;
  payload: unknown;
}
export interface MemoryArchiveQuery {
  jobId?: string; role?: MemoryArchiveRecord["role"]; kind?: MemoryArchiveRecord["kind"]; sessionKey?: string;
  cursor?: string; limit?: number;
}
export interface MemoryArchivePage { records: MemoryArchiveRecord[]; next: string | null }
export const ARCHIVE_PREFIX = "archive:";
const fields = ["version", "id", "jobId", "sessionKey", "role", "attempt", "sequence", "kind", "status", "model", "createdAt", "payload"];
/** Persist explicit identity/evidence, never arbitrary transport metadata. */
export function validateMemoryArchiveRecord(value: unknown): asserts value is MemoryArchiveRecord {
  const row = value as MemoryArchiveRecord;
  if (!row || typeof row !== "object" || Object.keys(row).some(key => !fields.includes(key)) || row.version !== 1 ||
    [row.id, row.jobId, row.sessionKey, row.attempt].some(value => typeof value !== "string" || !value || value.length > 512) ||
    !["audit", "memory", "summary"].includes(row.role) || !Number.isSafeInteger(row.sequence) || row.sequence < 0 ||
    !["request", "message", "tool", "outcome", "actions", "summary"].includes(row.kind) ||
    !["transient", "complete", "failed", "cancelled"].includes(row.status) ||
    !row.model || typeof row.model.id !== "string" || !row.model.id || Object.keys(row.model).some(key => !["id", "profile"].includes(key)) ||
    (row.model.profile !== undefined && typeof row.model.profile !== "string") ||
    typeof row.createdAt !== "string" || !Number.isFinite(Date.parse(row.createdAt)) || (!Object.hasOwn(row, "payload") || row.payload === undefined)) throw new Error("Invalid personal-memory archive record");
  // Tool arguments and quoted messages may discuss credentials; never interpret prose as transport configuration.
  if (row.kind === "request" && row.payload && typeof row.payload === "object" &&
    Object.keys(row.payload).some(key => /^(authorization|headers|auth|api[_-]?key|access[_-]?token|bearer)$/i.test(key))) throw new Error("Request archives cannot contain transport credentials");
  JSON.stringify(row);
}
export function validateMemoryArchive(records: unknown): asserts records is MemoryArchiveRecord[] {
  if (!Array.isArray(records)) throw new Error("Invalid personal-memory archive");
  const identities = new Map<string, string>();
  for (const row of records) {
    validateMemoryArchiveRecord(row);
    const bytes = JSON.stringify(row);
    const previous = identities.get(row.id);
    if (previous !== undefined && previous !== bytes) throw new Error("Conflicting immutable memory archive identity");
    identities.set(row.id, bytes);
  }
}
export function archiveKey(row: MemoryArchiveRecord): string {
  return `${ARCHIVE_PREFIX}${encodeURIComponent(row.jobId)}:${row.role}:${encodeURIComponent(row.attempt)}:${String(row.sequence).padStart(16, "0")}:${encodeURIComponent(row.id)}`;
}
export async function appendMemoryArchive(tx: StorageTransaction, records: MemoryArchiveRecord[]): Promise<void> {
  for (const row of records) {
    validateMemoryArchiveRecord(row);
    const key = archiveKey(row);
    const identityKey = `archive-id:${encodeURIComponent(row.id)}`;
    const identity = await tx.get("pipeline", identityKey);
    if (identity !== null && identity !== key) throw new Error("Conflicting immutable memory archive identity");
    const previous = await tx.get("pipeline", key);
    if (previous !== null && JSON.stringify(previous) !== JSON.stringify(row)) throw new Error("Conflicting immutable memory archive record");
    if (previous === null) {
      await tx.set("pipeline", key, row);
      await tx.set("pipeline", identityKey, key);
    }
  }
}
export async function readMemoryArchive(tx: StorageTransaction, query: MemoryArchiveQuery = {}): Promise<MemoryArchivePage> {
  if (!tx.scan) throw new Error("Storage does not support indexed archive paging");
  const limit = query.limit ?? 25;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("Archive page limit must be 1–100");
  const prefix = query.jobId === undefined ? ARCHIVE_PREFIX : `${ARCHIVE_PREFIX}${encodeURIComponent(query.jobId)}:`;
  if (query.cursor !== undefined && !query.cursor.startsWith(prefix)) throw new Error("Archive cursor is outside the selected scope");
  const page = await tx.scan<MemoryArchiveRecord>("pipeline", { prefix, after: query.cursor, limit });
  const records = page.entries.map(entry => { validateMemoryArchiveRecord(entry.value); return entry.value; }).filter(row =>
    (query.role === undefined || query.role === row.role) && (query.kind === undefined || query.kind === row.kind) &&
    (query.sessionKey === undefined || query.sessionKey === row.sessionKey));
  return { records, next: page.next };
}
export async function clearMemoryArchive(tx: StorageTransaction): Promise<void> {
  if (!tx.scan) throw new Error("Storage does not support indexed archive deletion");
  let after: string | undefined;
  do {
    const page = await tx.scan("pipeline", { prefix: ARCHIVE_PREFIX, after, limit: 100 });
    for (const entry of page.entries) {
      const row = entry.value as MemoryArchiveRecord;
      validateMemoryArchiveRecord(row);
      await tx.delete("pipeline", `archive-id:${encodeURIComponent(row.id)}`);
      await tx.delete("pipeline", entry.key);
    }
    after = page.next ?? undefined;
  } while (after !== undefined);
}
