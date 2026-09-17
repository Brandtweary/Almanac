import assert from "node:assert/strict";
import { test } from "node:test";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { PipelineRuntime, type PipelineDeps } from "../src/pipeline.js";
import { MemoryStorage } from "../src/memory-storage.js";
import { IndexedDBStorageBackend } from "../src/pi-web-ui/storage/backends/indexeddb-storage-backend.js";
import { Graph } from "../src/kg/graph.js";
import type { ConversationArchive } from "../src/conversation-history.js";

globalThis.indexedDB = new IDBFactory(); globalThis.IDBKeyRange = IDBKeyRange;
let serial = 0;
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return {promise,resolve}; };
const response = () => [{role:"assistant",content:[{type:"text",text:"Finished"}],stopReason:"stop",usage:{input:1,output:1}}] as any;
const call = (context:any,name:string,args:unknown) => context.tools.find((tool:any)=>tool.name===name).execute("call",args,undefined,undefined);
const finish = async(context:any) => { if(context.tools.some((tool:any)=>tool.name==="summary_draft")) await call(context,"summary_draft",{operation:"abstain",reason:"No update"}); else await call(context,"memory_finish",{outcome:"completed",reason:"Examined evidence"}); return response(); };
function history(label:string) { return { revision:1, archive:{version:1,complete:true,records:[{id:`record-${label}`,message:{role:"user",content:label,timestamp:1}}]} as ConversationArchive }; }
async function setup(options: { loop?:PipelineDeps["runLoop"]; raw?:IndexedDBStorageBackend } = {}) {
 const raw = options.raw ?? new IndexedDBStorageBackend({dbName:`source-deletion-${serial++}`,version:1,stores:["lexicon","pipeline","memory-consent"].map(name=>({name}))});
 const storage = new MemoryStorage(raw);const loaded=await storage.load();let graph=loaded.graph.present?new Graph(loaded.graph.value as any):Graph.empty();
 const histories=new Map<string,ReturnType<typeof history>>();let readError:Error|undefined;let writeError=false;let consent="granted";const errors:unknown[]=[];const calls:string[]=[];
 const runtime=new PipelineRuntime({backend:raw,getGraph:()=>graph,setGraph:value=>{graph=value},
  publishMemory:async(asset,state,archive,guard)=>{if(writeError)throw new Error("Storage unavailable");await storage.save({graph:asset,pipeline:state,...(archive?{archive}:{})},guard)},
  getRawHistory:async key=>{if(readError)throw readError;return structuredClone(histories.get(key)??null)},
  embed:async()=>null,getModel:()=>({}as any),getModelId:()=>"fixture",getBaseUrl:()=>"invalid",getAuth:()=>"",getConsent:()=>consent,
  addCost:()=>{},onStateChange:()=>{},onActivity:()=>{},onError:error=>errors.push(error),measureContext:async()=>1,getRoleInputBudget:()=>1000000,getRoleOutputBudget:()=>1000,
  runLoop:async(...args)=>{calls.push(String((args[0][0]as any).content));return options.loop?options.loop(...args):finish(args[1])}});
 runtime.loadSnapshot(loaded);
 const enqueue=async(key:string,label=key)=>{const saved=history(label);histories.set(key,saved);await runtime.onTurnEndHistory({sessionKey:key,...saved},false)};
 return {runtime,raw,storage,histories,calls,errors,graph:()=>graph,enqueue,setReadError:(error?:Error)=>{readError=error},setWriteError:(value:boolean)=>{writeError=value},revoke:()=>{consent="declined";return runtime.cancel()}};
}

test("retry retires deleted source jobs durably and runs unrelated queued conversations",async()=>{
 let fail=true;const h=await setup({loop:async(_prompt,context)=>{if(fail)throw new Error("Temporary provider outage");return finish(context)}});
 await h.enqueue("old");await h.runtime.whenIdle();await h.enqueue("new");await h.runtime.whenIdle();assert.equal(h.calls.length,1);
 h.histories.delete("old");fail=false;h.runtime.retryPending();await h.runtime.whenIdle();
 assert.equal(h.calls.length,4);assert.deepEqual(h.runtime.snapshot().jobs!.map(job=>job.sessionKey),["new"]);
 const cancelled=(await h.storage.readArchive()).records.filter(row=>row.status==="cancelled");
 assert.equal(cancelled.length,3);assert(cancelled.every(row=>row.sessionKey==="old"&&(row.payload as any).outcome.reason==="Source conversation deleted"));
 const reload=await setup({raw:h.raw});reload.runtime.resumePending();await reload.runtime.whenIdle();assert.equal(reload.calls.length,0);assert.equal(reload.runtime.hasFailedWork,false);
});

test("explicit source deletion aborts an in-flight draft while retaining other conversations",async()=>{
 const entered=deferred(),release=deferred();let first=true;let aborted=false;
 const h=await setup({loop:async(_prompt,context,_config,_emit,signal)=>{
  if(first){first=false;await call(context,"add_term",{label:"unpublished",description:"Private draft only."});entered.resolve();await release.promise;aborted=signal!.aborted}
  return finish(context);
 }});
 await h.enqueue("old");await entered.promise;await h.enqueue("new");h.histories.delete("old");await h.runtime.sourceDeleted("old");release.resolve();await h.runtime.whenIdle();
 assert(aborted);assert.equal(h.graph().get("unpublished"),null);assert.deepEqual(h.runtime.snapshot().jobs!.map(job=>job.sessionKey),["new"]);assert.equal(h.calls.length,4);
});

test("deletion outside the page is rechecked before a completed draft publishes",async()=>{
 const entered=deferred(),release=deferred();let first=true;
 const h=await setup({loop:async(_prompt,context)=>{if(first){first=false;await call(context,"add_term",{label:"unpublished",description:"Private draft only."});entered.resolve();await release.promise}return finish(context)}});
 await h.enqueue("old");await entered.promise;await h.enqueue("new");h.histories.delete("old");release.resolve();await h.runtime.whenIdle();
 assert.equal(h.graph().get("unpublished"),null);assert.deepEqual(h.runtime.snapshot().jobs!.map(job=>job.sessionKey),["new"]);assert.equal(h.calls.length,4);
});

test("source deletion retains acknowledged memory and cancels only unfinished roles",async()=>{
 let count=0;const h=await setup({loop:async(_prompt,context)=>{if(count++===0){await call(context,"add_term",{label:"committed",description:"Already committed memory."});return finish(context)}throw new Error("Memory role interrupted")}});
 await h.enqueue("old");await h.runtime.whenIdle();assert(h.graph().get("committed"));h.histories.delete("old");await h.runtime.sourceDeleted("old");
 assert(h.graph().get("committed"));const cancelled=(await h.storage.readArchive()).records.filter(row=>row.status==="cancelled");assert.deepEqual(cancelled.map(row=>row.role).sort(),["memory","summary"]);
});

test("unreadable and changed source histories stay fail-closed instead of being cancelled",async()=>{
 let fail=true;const h=await setup({loop:async(_prompt,context)=>{if(fail)throw new Error("Provider unavailable");return finish(context)}});
 await h.enqueue("old");await h.runtime.whenIdle();await h.enqueue("new");fail=false;
 h.setReadError(new Error("Database read failed"));h.runtime.retryPending();await h.runtime.whenIdle();assert.equal(h.calls.length,1);assert.equal(h.runtime.snapshot().jobs!.length,2);
 h.setReadError();const original=structuredClone(h.histories.get("old")!);h.histories.get("old")!.archive.records[0].message={role:"user",content:"Changed bytes",timestamp:1};
 h.runtime.retryPending();await h.runtime.whenIdle();assert.equal(h.calls.length,1);assert.equal((await h.storage.readArchive()).records.filter(row=>row.status==="cancelled").length,0);
 h.histories.set("old",original);h.runtime.retryPending();await h.runtime.whenIdle();assert.equal(h.calls.length,7);
});

test("failed cancellation publication retains the queue and is retryable without data loss",async()=>{
 let fail=true;const h=await setup({loop:async(_prompt,context)=>{if(fail)throw new Error("Provider unavailable");return finish(context)}});
 await h.enqueue("old");await h.runtime.whenIdle();await h.enqueue("new");h.histories.delete("old");fail=false;h.setWriteError(true);
 await assert.rejects(h.runtime.sourceDeleted("old"),/Storage unavailable/);assert.equal(h.runtime.snapshot().jobs!.length,2);assert.equal(h.calls.length,1);
 h.setWriteError(false);h.runtime.retryPending();await h.runtime.whenIdle();assert.deepEqual(h.runtime.snapshot().jobs!.map(job=>job.sessionKey),["new"]);assert.equal(h.calls.length,4);
});

test("consent revocation still prevents queued conversations from resuming after deletion",async()=>{
 const entered=deferred(),release=deferred();const h=await setup({loop:async(_prompt,context)=>{entered.resolve();await release.promise;return finish(context)}});
 await h.enqueue("old");await entered.promise;await h.enqueue("new");const revoked=h.revoke();h.histories.delete("old");await h.runtime.sourceDeleted("old");release.resolve();await revoked;await h.runtime.whenIdle();
 assert.equal(h.calls.length,1);assert.equal(h.runtime.snapshot().jobs!.length,0);assert.equal(h.graph().thoughts.size,0);
});

test("changed source bytes during inference discard the draft without treating corruption as deletion",async()=>{
 const entered=deferred(),release=deferred();const h=await setup({loop:async(_prompt,context)=>{await call(context,"add_term",{label:"unpublished",description:"Private draft only."});entered.resolve();await release.promise;return finish(context)}});
 await h.enqueue("old");await entered.promise;await h.enqueue("new");h.histories.get("old")!.archive.records[0].message={role:"user",content:"Replaced source",timestamp:1};release.resolve();await h.runtime.whenIdle();
 assert.equal(h.graph().get("unpublished"),null);assert.equal(h.calls.length,1);assert.equal(h.runtime.snapshot().jobs![0].stages.audit,"failed");assert.equal(h.runtime.snapshot().jobs!.length,2);assert.equal((await h.storage.readArchive()).records.filter(row=>row.status==="cancelled").length,0);
});

test("the deletion guard is necessary: instance-local mutation reproduces blocked progress",async()=>{
 let fail=true;const h=await setup({loop:async(_prompt,context)=>{if(fail)throw new Error("Provider unavailable");return finish(context)}});
 await h.enqueue("old");await h.runtime.whenIdle();await h.enqueue("new");h.histories.delete("old");fail=false;
 const retire=h.runtime.sourceDeleted.bind(h.runtime);
 try{
  h.runtime.sourceDeleted=async()=>undefined;
  await assert.rejects(async()=>{h.runtime.retryPending();await h.runtime.whenIdle();assert.equal(h.calls.length,4)},assert.AssertionError);
 }finally{h.runtime.sourceDeleted=retire}
 h.runtime.retryPending();await h.runtime.whenIdle();assert.equal(h.calls.length,4);assert.deepEqual(h.runtime.snapshot().jobs!.map(job=>job.sessionKey),["new"]);
});

test("automatic missing-source recovery reports a failed cancellation commit and retries safely",async()=>{
 let fail=true;const h=await setup({loop:async(_prompt,context)=>{if(fail)throw new Error("Provider unavailable");return finish(context)}});
 await h.enqueue("old");await h.runtime.whenIdle();await h.enqueue("new");h.histories.delete("old");fail=false;h.setWriteError(true);
 h.runtime.retryPending();await h.runtime.whenIdle();assert.equal(h.runtime.snapshot().jobs!.length,2);assert.equal(h.calls.length,1);assert(h.errors.some(error=>String(error).includes("Storage unavailable")));
 h.setWriteError(false);h.runtime.retryPending();await h.runtime.whenIdle();assert.deepEqual(h.runtime.snapshot().jobs!.map(job=>job.sessionKey),["new"]);assert.equal(h.calls.length,4);
});
