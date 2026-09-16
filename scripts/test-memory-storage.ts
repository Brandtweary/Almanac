import assert from "node:assert/strict";
import { test } from "node:test";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { MemoryStorage, MemoryStorageConflictError, LEGACY_PIPELINE_KEYS } from "../src/memory-storage.js";
import { IndexedDBStorageBackend } from "../src/pi-web-ui/storage/backends/indexeddb-storage-backend.js";
import { Graph } from "../src/kg/graph.js";
import { emptySttLexicon } from "../src/stt-lexicon.js";

globalThis.indexedDB = new IDBFactory();
globalThis.IDBKeyRange = IDBKeyRange;
let serial = 0;
function setup() {
	const name = `memory-storage-${serial++}`;
	const backend = () => new IndexedDBStorageBackend({ dbName: name, version: 1,
		stores: ["lexicon", "pipeline", "memory-consent"].map((name) => ({ name })) });
	const raw = backend();
	return { raw, a: new MemoryStorage(raw), b: new MemoryStorage(backend()) };
}
function graph(label: string) {
	const value = Graph.empty().serialize();
	value.thoughts[label] = { id: label, label, description: label, entity_type: null, aliases: [], hit_count: 0, metadata: null };
	value.meta.node_count = 1;
	return value;
}
function pipeline(text = "example") {
	return { buffers: { audit: [], memory: [], summary: [] }, flags: [], sttLexicon: emptySttLexicon(),
		runningContext: [{ sessionKey: "session", text, ts: "2026-01-01T00:00:00Z" }] };
}

test("two pages cannot overwrite each other's graph or resurrect deleted memory", async () => {
	const { raw, a, b } = setup();
	await Promise.all([a.load(), b.load()]);
	await a.save({ graph: graph("first") });
	await assert.rejects(b.save({ graph: graph("stale") }), MemoryStorageConflictError);
	assert.equal(b.invalidated, true);
	assert.deepEqual(Object.keys((await raw.get<any>("lexicon", "terms")).thoughts), ["first"]);
	await b.load();
	await a.save({ graph: Graph.empty().serialize(), pipeline: pipeline("cleared") });
	await assert.rejects(b.save({ graph: graph("resurrected") }), MemoryStorageConflictError);
	assert.deepEqual((await raw.get<any>("lexicon", "terms")).thoughts, {});
	assert.equal(await raw.get("pipeline", "revision"), 2);
});

test("pipeline-only saves participate in the same revision as graph saves", async () => {
	const { raw, a, b } = setup();
	await Promise.all([a.load(), b.load()]);
	await a.save({ pipeline: pipeline("new flag state") });
	await assert.rejects(b.save({ pipeline: pipeline("stale"), graph: graph("stale") }), MemoryStorageConflictError);
	assert.equal((await raw.get<any>("pipeline", "state")).runningContext[0].text, "new flag state");
	assert.equal(await raw.get("lexicon", "terms"), null);
});

test("consent revocation invalidates a different page's writer; explicit writes remain possible while off", async () => {
	const { raw, a, b } = setup();
	await Promise.all([a.load(), b.load()]);
	await a.save({ consent: "declined" });
	await assert.rejects(b.save({ graph: graph("background") }), MemoryStorageConflictError);
	assert.equal(await raw.get("memory-consent", "choice"), "declined");
	await a.save({ graph: graph("explicit-import") });
	assert.equal(await raw.get("pipeline", "revision"), 2);
});

test("same-page writes are ordered and payloads are immutable before any await", async () => {
	const { raw, a } = setup();
	await a.load();
	const first = graph("first");
	const write = a.save({ graph: first });
	first.thoughts.first.description = "mutated later";
	await write;
	assert.equal((await raw.get<any>("lexicon", "terms")).thoughts.first.description, "first");
	await Promise.all([a.save({ graph: graph("second") }), a.save({ graph: graph("third") }), a.save({ pipeline: pipeline() })]);
	assert.deepEqual(Object.keys((await raw.get<any>("lexicon", "terms")).thoughts), ["third"]);
	assert.equal(await raw.get("pipeline", "revision"), 4);
});

test("missing revision migrates from zero; canonical publication removes legacy slots atomically", async () => {
	const { raw, a } = setup();
	for (const key of LEGACY_PIPELINE_KEYS) await raw.set("pipeline", key, { legacy: key });
	const snapshot = await a.load();
	assert.equal(snapshot.revision, 0);
	assert.deepEqual(snapshot.pipeline, { present: false });
	for (const key of LEGACY_PIPELINE_KEYS) assert.deepEqual(snapshot.legacyPipeline[key], { present: true, value: { legacy: key } });
	await a.save({ pipeline: pipeline() });
	for (const key of LEGACY_PIPELINE_KEYS) assert.equal(await raw.has("pipeline", key), false);
	assert.equal(await raw.get("pipeline", "revision"), 1);
});

test("atomic load preserves null and undefined corruption as present rather than defaulting to empty", async () => {
	const { raw, a } = setup();
	await raw.set("lexicon", "terms", null);
	await raw.set("pipeline", "state", null);
	await raw.set("pipeline", "flags", undefined);
	await raw.set("memory-consent", "choice", null);
	const snapshot = await a.load();
	assert.deepEqual(snapshot.graph, { present: true, value: null });
	assert.deepEqual(snapshot.pipeline, { present: true, value: null });
	assert.equal(snapshot.legacyPipeline.flags.present, true);
	assert.deepEqual(snapshot.consent, { present: true, value: null });
});

for (const value of [null, undefined, -1, 1.5, "1", {}, Number.MAX_SAFE_INTEGER + 1]) {
	test(`malformed revision ${String(value)} fails closed`, async () => {
		const { raw, a } = setup();
		await raw.set("pipeline", "revision", value);
		await assert.rejects(a.load(), /Invalid saved memory revision/);
		await assert.rejects(a.save({ consent: "granted" }), /has not loaded/);
		assert.equal(await raw.has("memory-consent", "choice"), false);
	});
}

test("revision corruption after load is not overwritten by a save", async () => {
	const { raw, a } = setup();
	await a.load();
	await raw.set("pipeline", "revision", null);
	await assert.rejects(a.save({ graph: graph("new") }), /Invalid saved memory revision/);
	assert.equal(await raw.get("lexicon", "terms"), null);
});

test("revision exhaustion retains all saved fields", async () => {
	const { raw, a } = setup();
	await raw.set("pipeline", "revision", Number.MAX_SAFE_INTEGER);
	await a.load();
	await assert.rejects(a.save({ consent: "granted" }), /revision limit/);
	assert.equal(await raw.has("memory-consent", "choice"), false);
});

test("failed publication rolls back both fields and revision; same page can retry", async () => {
	const { raw } = setup();
	let fail = true;
	const client = new MemoryStorage({ transaction: (stores, mode, operation) => raw.transaction(stores, mode, async (tx) => {
		const result = await operation(tx);
		if (mode === "readwrite" && fail) { fail = false; throw new Error("storage failure"); }
		return result;
	}) });
	await client.load();
	await assert.rejects(client.save({ graph: graph("first"), pipeline: pipeline(), consent: "granted" }), /storage failure/);
	assert.equal(await raw.has("lexicon", "terms"), false);
	assert.equal(await raw.has("pipeline", "revision"), false);
	assert.equal(await raw.has("pipeline", "state"), false);
	assert.equal(await raw.has("memory-consent", "choice"), false);
	await client.save({ graph: graph("retry") });
	assert.equal(await raw.get("pipeline", "revision"), 1);
});

test("conflict invalidates queued writes until a deliberate reload", async () => {
	const { raw, a, b } = setup();
	await Promise.all([a.load(), b.load()]);
	await a.save({ consent: "declined" });
	const attempts = await Promise.allSettled([b.save({ graph: graph("stale") }), b.save({ pipeline: pipeline("stale") })]);
	assert.equal(attempts.every((result) => result.status === "rejected" && result.reason instanceof MemoryStorageConflictError), true);
	assert.equal(await raw.get("pipeline", "revision"), 1);
	await b.load();
	assert.equal(b.invalidated, false);
	await b.save({ graph: graph("explicit") });
	assert.equal(await raw.get("pipeline", "revision"), 2);
});
