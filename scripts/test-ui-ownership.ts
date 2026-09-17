import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { sendWithAdmission } from "../src/send-admission.js";
// Execute actual component modules with inert rendering/storage dependencies.
let getKey: () => Promise<unknown> = async () => "key";
const writes: unknown[][] = [];
const storage = { providerKeys: { get: () => getKey(), set: async (...args: unknown[]) => { writes.push(args); } } };
const decorator = () => () => undefined;
const dependencies = { LitElement: class { requestUpdate() {} }, customElement: () => (value: unknown) => value,
 sendWithAdmission, property: decorator, state: decorator, query: decorator, getAppStorage: () => storage, html: () => undefined };
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
assert.equal((sent[0] as any).content, "draft");
assert.equal(sent.length, 1);
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
{
 const { ui, sent } = chat();
 const gate = deferred<any>();
 getKey = () => gate.promise;
 const pending = ui.sendMessage("draft");
 ui.sendDisabled = true;
 gate.resolve("key");
 await pending;
 assert.equal(sent.length, 0, "conversation transition prevents dispatch to the old agent");
 assert.equal(ui._messageEditor.value, "draft", "conversation transition preserves the unsent draft");
}
console.log("7 send-admission edge cases passed");

getKey = async () => "key";
for (const mutation of ["none", "text", "attachments", "session"]) {
 const {ui} = chat();
 const gate = deferred<void>(); const entered = deferred<void>();
 const attachment = {id:"saved"};
 ui._messageEditor.attachments = [attachment];
 ui.session.prompt = async () => { entered.resolve(); await gate.promise; throw new Error("Context measurement unavailable"); };
 const pending = ui.sendMessage("draft", [attachment]);
 const rejected = assert.rejects(pending, /Context measurement unavailable/);
 await entered.promise;
 assert.equal(ui._messageEditor.value, "draft", "prompt admission keeps the original draft");
 if (mutation === "text") ui._messageEditor.value = "newer draft";
 if (mutation === "attachments") ui._messageEditor.attachments = [{id:"newer"}];
 if (mutation === "session") { ui.session = {state:{model:{provider:"new"}}}; ui._messageEditor = {value:"other chat",attachments:[]}; }
 gate.resolve(); await rejected;
 assert.equal(ui._messageEditor.value, mutation === "text" ? "newer draft" : mutation === "session" ? "other chat" : "draft");
 if (mutation === "none") assert.equal(ui._messageEditor.attachments[0], attachment);
 if (mutation === "attachments") assert.equal(ui._messageEditor.attachments[0].id, "newer");
 if (mutation !== "session") assert.match(ui._sendError,/Context measurement unavailable/);
}
{
 const {ui}=chat(); const gate=deferred<void>(); const entered=deferred<void>(); let listener:any; let submitted:any;
 ui.session.subscribe=(fn:any)=>{listener=fn;return()=>{listener=undefined;};};
 ui.session.prompt=async (message:any)=>{submitted=message;entered.resolve();await gate.promise;};
 const pending=ui.sendMessage("draft"); await entered.promise;
 listener({type:"message_start",message:{role:"user",content:"another message"}});
 assert.equal(ui._messageEditor.value,"draft","unrelated messages cannot accept this draft");
 listener({type:"message_start",message:submitted});
 assert.equal(ui._messageEditor.value,"");
 ui._messageEditor.value="draft";
 gate.resolve();await pending;
 assert.equal(ui._messageEditor.value,"draft","successful completion cannot erase a newly retyped identical draft");
 assert.equal(listener,undefined,"admission listener is removed");
}
for(const accepted of [false,true]){
 let listener:any;let recovered="";const message:any={role:"user",content:"recognized speech",timestamp:1};
 const session:any={subscribe:(fn:any)=>{listener=fn;return()=>{listener=undefined;};},prompt:async()=>{if(accepted)listener({type:"message_start",message});throw new Error("unavailable");}};
 await assert.rejects(sendWithAdmission(session,message,()=>{},()=>{recovered=message.content;}));
 assert.equal(recovered,accepted?"":"recognized speech","voice recovery applies only before admission");
 assert.equal(listener,undefined);
}
console.log("7 rejected-send, admission and voice-recovery cases passed");
