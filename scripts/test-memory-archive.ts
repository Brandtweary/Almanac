import assert from "node:assert/strict";
import { test } from "node:test";
import { IDBFactory, IDBKeyRange, IDBObjectStore } from "fake-indexeddb";
import { MemoryStorage, MemoryStorageConflictError } from "../src/memory-storage.js";
import { IndexedDBStorageBackend } from "../src/pi-web-ui/storage/backends/indexeddb-storage-backend.js";
import { validateMemoryArchiveRecord, validateMemoryArchive, type MemoryArchiveRecord } from "../src/memory-archive.js";
import { Graph } from "../src/kg/graph.js";
globalThis.indexedDB=new IDBFactory(); globalThis.IDBKeyRange=IDBKeyRange;
function setup(){const dbName=crypto.randomUUID();const backend=()=>new IndexedDBStorageBackend({dbName,version:1,stores:["lexicon","pipeline","memory-consent"].map(name=>({name}))});return {a:new MemoryStorage(backend()),b:new MemoryStorage(backend()),raw:backend()};}
function record(sequence=0):MemoryArchiveRecord{return {version:1,id:crypto.randomUUID(),jobId:"job",sessionKey:"chat",role:"audit",attempt:"attempt",sequence,kind:"message",status:"transient",model:{id:"fixture",profile:"offline"},createdAt:"2026-01-01T00:00:00Z",payload:{content:`original ${sequence}`}};}
test("archive pages scan bounded primary-index records and preserve filtered continuation",async()=>{
 const {a}=setup();await a.load();const records=Array.from({length:9},(_,i)=>record(i));records[8].role="summary";await a.save({archive:records});
 const first=await a.readArchive({jobId:"job",role:"summary",limit:3});assert.equal(first.records.length,0);assert.ok(first.next);
 let cursor=first.next!,found:MemoryArchiveRecord[]=[];do{const page=await a.readArchive({jobId:"job",role:"summary",limit:3,cursor});found.push(...page.records);cursor=page.next!;}while(cursor);
 assert.deepEqual(found,[records[8]]);await assert.rejects(a.readArchive({jobId:"other",cursor:first.next!}),/scope/);
 assert.deepEqual((await a.exportData()).archive,records);
});
test("immutable duplicate replay is idempotent but same identity with altered payload or position fails",async()=>{
 const {a}=setup();await a.load();const row=record();await a.save({archive:[row]});await a.save({archive:[row]});
 await assert.rejects(a.save({archive:[{...row,payload:"changed"}]}),/immutable/);
 await assert.rejects(a.save({archive:[{...row,sequence:99}]}),/identity/);
 assert.equal((await a.readArchive()).records.length,1);
});
test("stage publication and successful archive outcome roll back together",async()=>{
 const {a}=setup();await a.load();const row=record();await a.save({archive:[row],graph:Graph.empty().serialize()});
 const original=IDBObjectStore.prototype.put;
 IDBObjectStore.prototype.put=function(...args){const request=original.apply(this,args);if(this.name==="lexicon")request.addEventListener("success",()=>this.transaction.abort());return request;};
 try{await assert.rejects(a.save({archive:[{...record(1),kind:"outcome",status:"complete"}],graph:Graph.empty().serialize()}));}finally{IDBObjectStore.prototype.put=original;}
 assert.deepEqual((await a.exportData()).archive,[row]);
});
test("revocation guard invalidates queued writes while retaining prior archive; other tabs cannot overwrite",async()=>{
 const {a,b}=setup();await Promise.all([a.load(),b.load()]);const row=record();await a.save({archive:[row]});
 await assert.rejects(b.save({archive:[record(1)]}),MemoryStorageConflictError);
 let active=true;const pending=a.save({archive:[record(2)]},()=>{if(!active)throw new Error("revoked");});active=false;
 await assert.rejects(pending,/revoked/);await a.save({consent:"declined"});assert.deepEqual((await a.exportData()).archive,[row]);
});
test("explicit replacement/deletion atomically removes archive records and identity indexes",async()=>{
 const {a,raw}=setup();await a.load();await a.save({archive:[record(),record(1)]});
 const replacement=record(2);await a.save({clearArchive:true,archive:[replacement],graph:Graph.empty().serialize()});
 assert.deepEqual((await a.exportData()).archive,[replacement]);
 await a.save({clearArchive:true,archive:[]});assert.deepEqual((await a.exportData()).archive,[]);
 assert.deepEqual(await raw.keys("pipeline","archive-id:"),[]);
});
test("archive request envelopes reject credential/config metadata without censoring quoted conversation",()=>{
 const row=record();assert.throws(()=>validateMemoryArchiveRecord({...row,auth:"secret"}),/Invalid/);
 assert.throws(()=>validateMemoryArchiveRecord({...row,model:{id:"fixture",apiKey:"secret"}}),/Invalid/);
 assert.throws(()=>validateMemoryArchiveRecord({...row,kind:"request",payload:{headers:{Authorization:"secret"}}}),/credentials/);
 validateMemoryArchiveRecord({...row,payload:{content:"The manual discusses API keys"}});
});

test("archive import rejects conflicting identities before replacement begins",()=>{
 const row=record();validateMemoryArchive([row,row]);
 assert.throws(()=>validateMemoryArchive([row,{...row,sequence:1}]),/identity/);
});
