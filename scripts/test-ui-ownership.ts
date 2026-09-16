import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
// Execute actual component modules with inert rendering/storage dependencies.
let getKey: () => Promise<unknown> = async () => "key";
const writes: unknown[][] = [];
const storage = { providerKeys: { get: () => getKey(), set: async (...args: unknown[]) => { writes.push(args); } } };
const decorator = () => () => undefined;
const dependencies = { LitElement: class { requestUpdate() {} }, customElement: () => (value: unknown) => value,
 property: decorator, state: decorator, query: decorator, getAppStorage: () => storage, html: () => undefined };
function load(file: string) {
 const js = ts.transpileModule(readFileSync(new URL(file, import.meta.url), "utf8"), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, experimentalDecorators: true, useDefineForClassFields: false },
 }).outputText;
 const exports: Record<string, any> = {};
 vm.runInNewContext(js, { exports, require: () => dependencies, console, customElements: { get: () => true }, setTimeout: () => 0 });
 return exports;
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; }
const { AgentInterface } = load("../src/pi-web-ui/components/AgentInterface.ts");
for (const stage of ["lookup", "dialog", "hook"]) {
 const gate = deferred<any>();
 const sent: string[] = [];
 const original = { state: { model: { provider: "original" } }, prompt: async () => { sent.push("original"); } };
 const replacement = { state: { model: { provider: "replacement" } }, prompt: async () => { sent.push("replacement"); } };
 const ui = new AgentInterface();
 ui.session = original;
 ui._messageEditor = { value: "new draft", attachments: ["new attachment"] };
 getKey = stage === "lookup" ? () => gate.promise : async () => stage === "dialog" ? undefined : "key";
 ui.onApiKeyRequired = () => gate.promise;
 ui.onBeforeSend = stage === "hook" ? () => gate.promise : undefined;
 const sending = ui.sendMessage("old draft");
 await Promise.resolve(); await Promise.resolve();
 ui.session = replacement;
 gate.resolve(true);
 await sending;
 assert.deepEqual(sent, [], `${stage}: stale send must not dispatch`);
 assert.equal(ui._messageEditor.value, "new draft", `${stage}: replacement draft survives`);
}
const { ProviderKeyInput } = load("../src/pi-web-ui/components/ProviderKeyInput.ts");
for (const change of ["key", "provider"]) {
 const gate = deferred<boolean>();
 const component = new ProviderKeyInput();
 component.provider = "original";
 component.keyInput = "tested-key";
 component.testApiKey = () => gate.promise;
 const operation = component.saveKey();
 if (change === "key") component.keyInput = "replacement-key";
 else component.provider = "replacement";
 gate.resolve(true);
 await operation;
 assert.equal(writes.length, 0, `${change}: stale validation must not persist`);
 assert.equal(component.hasKey, false);
}
getKey = async () => "key";
const sent: unknown[] = [];
const ui = new AgentInterface();
ui.session = { state: { model: { provider: "same" } }, prompt: async (input: unknown) => { sent.push(input); } };
ui._messageEditor = { value: "draft", attachments: [] };
await ui.sendMessage("draft");
assert.deepEqual(sent, ["draft"]);
assert.equal(ui._messageEditor.value, "");
const valid = new ProviderKeyInput();
valid.provider = "same";
valid.keyInput = "tested-key";
valid.testApiKey = async () => true;
await valid.saveKey();
assert.deepEqual(writes, [["same", "tested-key"]]);
assert.equal(valid.hasKey, true);
console.log("7 async UI ownership cases passed");

function chat() {
 const ui = new AgentInterface();
 const sent: any[] = [];
 ui.session = { state: { model: { provider: "same" }, isStreaming: false }, prompt: async (value: unknown) => { sent.push(value); } };
 ui._messageEditor = { value: "draft", attachments: [] };
 return { ui, sent };
}
{
 const { ui, sent } = chat();
 await ui.sendMessage("  ");
 assert.equal(sent.length, 0, "undefined attachments and blank input is empty");
}
for (const stage of ["lookup", "hook"]) {
 const { ui, sent } = chat();
 const gate = deferred<any>();
 const originalAttachment = { id: "submitted" };
 const selected = [originalAttachment];
 ui._messageEditor.attachments = selected;
 getKey = stage === "lookup" ? () => gate.promise : async () => "key";
 ui.onBeforeSend = stage === "hook" ? () => gate.promise : undefined;
 const sending = ui.sendMessage("draft", selected);
 await Promise.resolve();
 ui._messageEditor.value = "new draft";
 selected.push({ id: "new-selection" });
 gate.resolve("key");
 await sending;
 assert.equal(ui._messageEditor.value, "new draft", `${stage}: preserve newer text`);
 assert.equal(ui._messageEditor.attachments.length, 2, `${stage}: preserve newer attachments`);
 assert.equal(sent.length, 1);
 assert.equal(sent[0].attachments.length, 1, `${stage}: submitted attachment list is immutable`);
 assert.equal(sent[0].attachments[0], originalAttachment);
}
{
 const { ui, sent } = chat();
 const gate = deferred<any>();
 getKey = () => gate.promise;
 const first = ui.sendMessage("draft");
 const second = ui.sendMessage("draft");
 gate.resolve("key");
 await Promise.all([first, second]);
 assert.equal(sent.length, 1, "same-session preflight sends coalesce");
}
{
 const { ui, sent } = chat();
 const gate = deferred<any>();
 getKey = () => gate.promise;
 const first = ui.sendMessage("draft");
 ui.session.state.isStreaming = true;
 gate.resolve("key");
 await first;
 assert.equal(sent.length, 0, "stream started during preflight prevents dispatch");
 assert.equal(ui._messageEditor.value, "draft", "stream collision preserves draft");
}
{
 const { ui, sent } = chat();
 const gate = deferred<any>();
 getKey = () => gate.promise;
 const old = ui.sendMessage("draft");
 const newer: unknown[] = [];
 ui.session = { state: { model: { provider: "new" } }, prompt: async (value: unknown) => { newer.push(value); } };
 getKey = async () => "key";
 await ui.sendMessage("draft");
 assert.equal(newer.length, 1, "replacement session need not wait for old preflight");
 gate.resolve("key");
 await old;
 assert.equal(sent.length, 0);
}
console.log("6 send-admission edge cases passed");
