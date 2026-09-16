import assert from "node:assert/strict";
import { test } from "node:test";
import { IDBDatabase, IDBObjectStore, IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { IndexedDBStorageBackend } from "../src/pi-web-ui/storage/backends/indexeddb-storage-backend.js";

globalThis.indexedDB = new IDBFactory();
globalThis.IDBKeyRange = IDBKeyRange;
let serial = 0;
function backend() {
	return new IndexedDBStorageBackend({
		dbName: `storage-test-${serial++}`,
		version: 1,
		stores: [
			{ name: "values" },
			{ name: "records", keyPath: "id", indices: [{ name: "unique", keyPath: "unique", unique: true }] },
		],
	});
}

for (const action of ["set", "delete", "clear"] as const) {
	test(`${action} resolves only after transaction completion`, async () => {
		const db = backend();
		await db.set("values", "key", "original");
		const original = IDBDatabase.prototype.transaction;
		let complete = false;
		IDBDatabase.prototype.transaction = function (...args) {
			const tx = original.apply(this, args);
			tx.addEventListener("complete", () => { complete = true; });
			return tx;
		};
		try {
			if (action === "set") await db.set("values", "key", "replacement");
			if (action === "delete") await db.delete("values", "key");
			if (action === "clear") await db.clear("values");
			assert.equal(complete, true);
		} finally {
			IDBDatabase.prototype.transaction = original;
		}
	});

	test(`${action} rejects an abort after request success and preserves saved data`, async () => {
		const db = backend();
		await db.set("values", "key", "original");
		const method = action === "set" ? "put" : action;
		const original = IDBObjectStore.prototype[method];
		(IDBObjectStore.prototype[method] as any) = function (this: IDBObjectStore, ...args: any[]) {
			const request = (original as any).apply(this, args);
			request.addEventListener("success", () => queueMicrotask(() => this.transaction.abort()));
			return request;
		};
		try {
			await assert.rejects(async () => {
				if (action === "set") await db.set("values", "key", "replacement");
				if (action === "delete") await db.delete("values", "key");
				if (action === "clear") await db.clear("values");
			}, { name: "AbortError" });
		} finally {
			(IDBObjectStore.prototype[method] as any) = original;
		}
		assert.equal(await db.get("values", "key"), "original");
	});
}

test("multi-store transaction returns callback result only after atomic commit", async () => {
	const db = backend();
	const result = await db.transaction(["values", "records"], "readwrite", async (tx) => {
		await tx.set("values", "key", "saved");
		await tx.set("records", "ignored-inline-key", { id: "record", unique: "one" });
		return 42;
	});
	assert.equal(result, 42);
	assert.equal(await db.get("values", "key"), "saved");
	assert.deepEqual(await db.get("records", "record"), { id: "record", unique: "one" });
});

test("callback failure rolls back all stores and preserves the original error", async () => {
	const db = backend();
	const failure = new Error("callback failed");
	await assert.rejects(db.transaction(["values", "records"], "readwrite", async (tx) => {
		await tx.set("values", "key", "partial");
		await tx.set("records", "record", { id: "record", unique: "one" });
		throw failure;
	}), (error) => error === failure);
	assert.equal(await db.get("values", "key"), null);
	assert.equal(await db.get("records", "record"), null);
});

test("callback can await another task without auto-committing partial writes", async () => {
	const db = backend();
	await assert.rejects(db.transaction(["values"], "readwrite", async (tx) => {
		await tx.set("values", "key", "partial");
		await new Promise((resolve) => setTimeout(resolve, 10));
		await tx.set("values", "other", "partial");
		throw new Error("reject after async gap");
	}), /reject after async gap/);
	assert.deepEqual(await db.keys("values"), []);
});

test("caught request failure still rejects an aborted transaction", async () => {
	const db = backend();
	await assert.rejects(db.transaction(["values", "records"], "readwrite", async (tx) => {
		await tx.set("values", "key", "partial");
		await tx.set("records", "one", { id: "one", unique: "same" });
		try { await tx.set("records", "two", { id: "two", unique: "same" }); } catch { /* Test callback consumes request error. */ }
		return "not committed";
	}), { name: "ConstraintError" });
	assert.deepEqual(await db.keys("values"), []);
	assert.deepEqual(await db.keys("records"), []);
});

test("synchronous clone failure rejects and rolls back an earlier write", async () => {
	const db = backend();
	await assert.rejects(db.transaction(["values"], "readwrite", async (tx) => {
		await tx.set("values", "key", "partial");
		await tx.set("values", "invalid", () => undefined);
	}), { name: "DataCloneError" });
	assert.deepEqual(await db.keys("values"), []);
});

test("readonly transactions preserve request values and reject writes", async () => {
	const db = backend();
	await db.set("values", "key", "saved");
	assert.equal(await db.transaction(["values"], "readonly", (tx) => tx.get("values", "key")), "saved");
	await assert.rejects(db.transaction(["values"], "readonly", (tx) => tx.delete("values", "key")), { name: "ReadOnlyError" });
	assert.equal(await db.get("values", "key"), "saved");
});
