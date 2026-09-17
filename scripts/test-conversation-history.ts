import assert from "node:assert/strict";
import { test } from "node:test";
import { IDBFactory, IDBKeyRange, IDBObjectStore } from "fake-indexeddb";
import { ConversationHistory, createConversationHistoryTool, historyWithoutPersonalMemory } from "../src/conversation-history.js";
import { SessionsStore } from "../src/pi-web-ui/storage/stores/sessions-store.js";
import { IndexedDBStorageBackend } from "../src/pi-web-ui/storage/backends/indexeddb-storage-backend.js";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
globalThis.indexedDB = new IDBFactory();
globalThis.IDBKeyRange = IDBKeyRange;
const user = (text: string): AgentMessage => ({ role: "user", content: text, timestamp: 123 });
const execute = async (tool: ReturnType<typeof createConversationHistoryTool>, args: any) => JSON.parse((await tool.execute("call", args)).content[0].text!);
function sessions() {
  const store = new SessionsStore();
  const backend = new IndexedDBStorageBackend({ dbName: crypto.randomUUID(), version: 1, stores: [store.getConfig(), SessionsStore.getMetadataConfig()] });
  store.setBackend(backend);
  return store;
}
function fixture() {
  const history = new ConversationHistory(); history.capture(user("Original 12 ft, not 12 m"));
  return { data: { id: "chat", title: "test", messages: [user("active summary")], rawHistory: history.snapshot(), model: { id: "test" }, thinkingLevel: "off", createdAt: new Date().toISOString(), lastModified: new Date().toISOString() } as any,
    meta: { id: "chat", title: "test", createdAt: new Date().toISOString(), lastModified: new Date().toISOString(), messageCount: 1, thinkingLevel: "off", preview: "test", usage: {input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}} } as any };
}
test("immutable original payloads and duplicate identical messages survive context replacement and reload", () => {
  const history = new ConversationHistory();
  const message = user("same"); history.capture(message); history.capture(message); history.capture(user("same"));
  const tool = { role: "toolResult", toolCallId: "a", toolName: "corpus_read", content: [{type:"text",text:"exact source"}], details: {page: 7}, isError: false, timestamp:123 } as AgentMessage;
  history.capture(tool);
  (message as any).content = "changed"; (tool as any).content = [];
  const saved = history.snapshot();
  assert.equal(saved.records.length, 3); assert.notEqual(saved.records[0].id, saved.records[1].id);
  assert.equal((saved.records[0].message as any).content, "same");
  assert.equal((saved.records[2].message as any).content[0].text, "exact source");
  assert.deepEqual(new ConversationHistory(JSON.parse(JSON.stringify(saved))).snapshot(), saved);
  saved.records.length = 0; assert.equal(history.messages().length, 3);
});
test("legacy originals are marked incomplete; summaries never become original testimony", () => {
  const history = new ConversationHistory(undefined, [user("recoverable"), {role:"compactionSummary", summary:"old"} as any]);
  assert.equal(history.snapshot().complete, false); assert.equal(history.messages().length, 1);
  assert.equal(new ConversationHistory().snapshot().complete, true);
  const saved = history.snapshot(); saved.records.push(saved.records[0]);
  assert.throws(() => new ConversationHistory(saved), /Invalid/);
});
test("bounded history search and paged reads preserve exact bytes and enforce scope", async () => {
  const history = new ConversationHistory();
  for(let i=0;i<25;i++) history.capture(user(`needle ${i} ${"x".repeat(4000)}`));
  let active = true;
  const tool = createConversationHistoryTool(history, () => { if(!active) throw new Error("stale"); });
  const first = await execute(tool,{query:"needle"}); assert.equal(first.records.length,12); assert.equal(first.next,12);
  const second = await execute(tool,{query:"needle",cursor:first.next}); assert.equal(second.next,24);
  const third = await execute(tool,{query:"needle",cursor:second.next}); assert.equal(third.next,null); assert.equal(third.records.length,1);
  let text="", cursor=0;
  do { const page=await execute(tool,{id:first.records[0].id,cursor}); text+=page.text; cursor=page.next; } while(cursor!==null);
  assert.equal(text,JSON.stringify(history.snapshot().records[0].message));
  await assert.rejects(execute(tool,{id:"other conversation"}),/Unknown/);
  assert.deepEqual((await execute(tool,{query:"missing"})).records,[]);
  active=false; await assert.rejects(execute(tool,{}),/stale/);
});
test("archive save is atomic, stale tabs cannot overwrite or resurrect deleted history", async () => {
  const store=sessions(), {data,meta}=fixture();
  await store.save(data,meta,-1);
  assert.equal((await store.get("chat"))?.revision,1);
  await assert.rejects(store.save({...data,title:"stale"},meta,-1),/another tab/);
  assert.equal((await store.get("chat"))?.title,"test");
  await store.delete("chat");
  await assert.rejects(store.save(data,meta,1),/deleted/);
  assert.equal(await store.get("chat"),null); assert.equal(await store.getMetadata("chat"),null);
});
test("session export/import preserves originals under a fresh session identity and rejects malformed archive", async () => {
  const store=sessions(),{data,meta}=fixture();
  data.messages.push({role:"memory-context",block:"remembered",timestamp:"now"},{role:"compactionSummary",summary:"short",tokensBefore:100,timestamp:"now"});
  await store.save(data,meta,-1);
  const exported=await store.exportSession("chat"); const id=await store.importSession(exported);
  assert.notEqual(id,"chat"); assert.deepEqual((await store.get(id))?.rawHistory,data.rawHistory);
  const corrupt=JSON.parse(exported); corrupt.session.rawHistory.records.push(corrupt.session.rawHistory.records[0]);
  await assert.rejects(store.importSession(JSON.stringify(corrupt)),/Invalid/);
});
test("transaction failure preserves both original archive and metadata", async () => {
  const store=sessions(),{data,meta}=fixture(); await store.save(data,meta,-1);
  const original=IDBObjectStore.prototype.put;
  IDBObjectStore.prototype.put=function(...args) { const request=original.apply(this,args); if(this.name==="sessions-metadata") request.addEventListener("success",()=>this.transaction.abort()); return request; };
  try { await assert.rejects(store.save({...data,rawHistory:{version:1,complete:true,records:[]}}, {...meta,title:"changed"},1)); }
  finally { IDBObjectStore.prototype.put=original; }
  assert.deepEqual((await store.get("chat"))?.rawHistory,data.rawHistory); assert.equal((await store.getMetadata("chat"))?.title,"test");
});

test("memory-off projection prevents history search/read bypass while preserving export originals", async () => {
    const history = new ConversationHistory();
  history.capture(user("ordinary user text"));
  history.capture({role:"toolResult",toolName:"memory_search",content:[{type:"text",text:"hidden private recall"}]} as any);
  history.capture({role:"toolResult",toolName:"conversation_history",content:[{type:"text",text:"hidden private recall via history"}]} as any);
  history.capture({role:"assistant",content:[{type:"text",text:"visible response"},{type:"toolCall",id:"x",name:"memory_search",arguments:{query:"private query"}}]} as any);
  const tool=createConversationHistoryTool(history,()=>{},historyWithoutPersonalMemory);
  assert.deepEqual((await execute(tool,{query:"private"})).records,[]);
  const saved=history.snapshot();
  await assert.rejects(execute(tool,{id:saved.records[1].id}),/consent/);
  const reply=await execute(tool,{id:saved.records[3].id});
  assert.equal(reply.redacted,true); assert.match(reply.text,/visible response/); assert.doesNotMatch(reply.text,/private query/);
  assert.match(JSON.stringify(saved),/hidden private recall/);
});

test("attachments survive capture, paged reads, reload and import with source provenance", async () => {
  const message = { role: "user-with-attachments", content: "Read this report", timestamp: 123,
    attachments: [{ id: "file", type: "document", fileName: "report.txt", mimeType: "text/plain", size: 4, content: "ZGF0YQ==", extractedText: "exact uploaded source" }] } as AgentMessage;
  const history = new ConversationHistory(); history.capture(message);
  assert.deepEqual(history.messages(), [message]);
  assert.deepEqual(new ConversationHistory(history.snapshot()).messages(), [message]);
  const found = await execute(createConversationHistoryTool(history, () => {}), {query:"exact uploaded source"});
  assert.equal(found.records.length, 1); assert.match(found.records[0].provenance, /user statement/); assert.match(found.records[0].provenance, /not user testimony/);
  const page = await execute(createConversationHistoryTool(history, () => {}), {id:found.records[0].id});
  assert.deepEqual(JSON.parse(page.text), message);
  const store = sessions(), {data,meta} = fixture(); data.messages = [message]; data.rawHistory = history.snapshot();
  await store.save(data,meta,-1);
  const exported = await store.exportSession("chat");
  const imported = await store.get(await store.importSession(exported));
  assert.deepEqual(imported?.messages, [message]); assert.deepEqual(imported?.rawHistory, history.snapshot());
  const legacy = JSON.parse(exported); delete legacy.session.rawHistory;
  const recovered = await store.get(await store.importSession(JSON.stringify(legacy)));
  assert.deepEqual(recovered?.rawHistory?.records.map(row => row.message), [message]);
  const invalid = JSON.parse(exported); invalid.session.messages[0].attachments = {};
  await assert.rejects(store.importSession(JSON.stringify(invalid)), /Invalid/);
  const invalidArchive = history.snapshot(); (invalidArchive.records[0].message as any).attachments[0].content = null;
  assert.throws(() => new ConversationHistory(invalidArchive), /Invalid/);
});

test("rename atomically preserves saved history, advances revision and rejects stale writers", async () => {
  const store = sessions(), {data,meta} = fixture(); await store.save(data,meta,-1);
  const revision = await store.updateTitle("chat", "renamed", 1);
  assert.equal(revision, 2); assert.equal((await store.getMetadata("chat"))?.title,"renamed");
  const saved = await store.get("chat"); assert.equal(saved?.title,"renamed"); assert.equal(saved?.revision,2);
  assert.deepEqual(saved?.rawHistory,data.rawHistory);
  await assert.rejects(store.save(data,meta,1), /another tab/);
  await assert.rejects(store.updateTitle("chat","stale",1), /another tab/);
  await store.save({...saved!,messages:[user("new saved message")]},{...meta,title:"renamed"},2);
  assert.equal(await store.updateTitle("chat","latest",3),4);
  assert.deepEqual((await store.get("chat"))?.messages,[user("new saved message")]);
  await store.delete("chat"); await assert.rejects(store.updateTitle("chat","resurrect",4), /deleted/);
  assert.equal(await store.get("chat"),null); assert.equal(await store.getMetadata("chat"),null);
});

test("rename transaction rollback leaves both title copies and revision intact", async () => {
  const store = sessions(), {data,meta} = fixture(); await store.save(data,meta,-1);
  const original = IDBObjectStore.prototype.put;
  IDBObjectStore.prototype.put = function(...args) { const request = original.apply(this,args); if (this.name === "sessions-metadata") request.addEventListener("success", () => this.transaction.abort()); return request; };
  try { await assert.rejects(store.updateTitle("chat","changed",1)); }
  finally { IDBObjectStore.prototype.put = original; }
  assert.equal((await store.get("chat"))?.title,"test"); assert.equal((await store.get("chat"))?.revision,1);
  assert.equal((await store.getMetadata("chat"))?.title,"test");
});

test("racing rename and save admit one revision and keep data and metadata consistent", async () => {
  const store = sessions(), {data,meta} = fixture(); await store.save(data,meta,-1);
  const results = await Promise.allSettled([
    store.updateTitle("chat","renamed",1),
    store.save({...data,title:"saved",messages:[user("concurrent message")]},{...meta,title:"saved"},1),
  ]);
  assert.equal(results.filter(result => result.status === "fulfilled").length,1);
  assert.equal(results.filter(result => result.status === "rejected").length,1);
  const saved = await store.get("chat"); assert.equal(saved?.revision,2);
  assert.equal(saved?.title,(await store.getMetadata("chat"))?.title);
  assert.deepEqual(saved?.messages,results[0].status === "fulfilled" ? data.messages : [user("concurrent message")]);
});
