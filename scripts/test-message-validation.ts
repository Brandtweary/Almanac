import JSZip from "jszip";
import assert from "node:assert/strict";
import { test } from "node:test";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { SessionsStore, validSessionMetadata } from "../src/pi-web-ui/storage/stores/sessions-store.js";
import { IndexedDBStorageBackend } from "../src/pi-web-ui/storage/backends/indexeddb-storage-backend.js";
import { ConversationHistory } from "../src/conversation-history.js";
import { formatTranscript } from "../src/pipeline.js";
import { withoutPersonalMemory, validatePipelineState } from "../src/memory-state.js";
import { validSavedUsage } from "../src/message-validation.js";

globalThis.indexedDB = new IDBFactory(); globalThis.IDBKeyRange = IDBKeyRange;
const zero = () => ({input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}});
const user = {role:"user",content:"ordinary statement",timestamp:1};
const assistant = {role:"assistant",content:[{type:"text",text:"answer"}],api:"openai-completions",provider:"local",model:"fixture",usage:zero(),stopReason:"stop",timestamp:2};
const tool = {role:"toolResult",toolCallId:"call",toolName:"source_read",content:[{type:"text",text:"reference"}],isError:false,timestamp:3};
async function setup() {
 const store=new SessionsStore();const backend=new IndexedDBStorageBackend({dbName:crypto.randomUUID(),version:1,stores:[store.getConfig(),SessionsStore.getMetadataConfig(),{name:"memory-consent"}]});store.setBackend(backend);
 const createdAt="2026-01-01T00:00:00.000Z";const messages=[structuredClone(user),structuredClone(assistant),structuredClone(tool)] as any;
 const data={id:"original",title:"Saved chat",model:{id:"fixture"},thinkingLevel:"off",createdAt,lastModified:createdAt,messages,rawHistory:new ConversationHistory(undefined,messages).snapshot()} as any;
 const meta={id:data.id,title:data.title,createdAt,lastModified:createdAt,messageCount:messages.length,usage:zero(),thinkingLevel:"off",preview:"ordinary statement"} as any;
 await store.save(data,meta,-1);await backend.set("memory-consent","choice","declined");
 return {store,backend,data,meta,exported:JSON.parse(await store.exportSession("original"))};
}
const malformedAttachments=[
 ...[{size:0},{content:"!!!!"},{size:1.5},{preview:"invalid"}].map(patch=>({role:"user-with-attachments",content:"attachment",timestamp:1,attachments:[{id:"a",type:"document",fileName:"a.txt",mimeType:"text/plain",size:1,content:"YQ==",...patch}]})),
 {role:"user-with-attachments",content:"attachment",timestamp:1,attachments:Array(11).fill({id:"a",type:"document",fileName:"a.txt",mimeType:"text/plain",size:1,content:"YQ=="})},
];
const malformed=[
 {...assistant,content:[null]}, {...tool,content:[null]}, {...assistant,content:"invalid assistant string"},
 {...tool,content:"invalid result string"}, {...assistant,content:[{type:"text",text:123}]},
 {...assistant,content:[{type:"thinking",thinking:null}]}, {...assistant,content:[{type:"toolCall",id:"call",name:"read",arguments:null}]},
 {...assistant,content:[{type:"toolCall",id:"call",name:"read",arguments:[]}]}, {...assistant,content:[{type:"toolCall",id:3,name:"read",arguments:{}}]},
 {...assistant,content:[{type:"image",data:"AA==",mimeType:"image/png"}]},
 {...tool,content:[{type:"thinking",thinking:"not a result block"}]}, {...tool,content:[{type:"unknown",text:"invalid"}]},
 {...user,content:[null]}, {...assistant,content:[{type:"text",text:"valid prefix"},null]},
 {...assistant,content:Array(1)},
];

test("malformed active or raw-history blocks reject uploaded exports before either store changes",async()=>{
 const h=await setup();
 for(const bad of [...malformed,...malformedAttachments])for(const target of["active","raw"]){
  const input=structuredClone(h.exported);if(target==="active")input.session.messages=[bad];else input.session.rawHistory.records[0].message=bad;
  await assert.rejects(h.store.importSession(JSON.stringify(input)),/Invalid/);
  assert.deepEqual(await h.backend.keys("sessions"),["original"]);assert.deepEqual(await h.backend.keys("sessions-metadata"),["original"]);
  assert.deepEqual(await h.backend.get("sessions","original"),{...h.data,revision:1});assert.equal(await h.backend.get("memory-consent","choice"),"declined");
 }
});

test("all supported SDK content blocks and a real zero-cost usage object round-trip unchanged",async()=>{
 const h=await setup();const input=structuredClone(h.exported);
 input.session.messages=[{...user,content:[{type:"text",text:"Read this",textSignature:"signature"},{type:"image",data:"AA==",mimeType:"image/png"}]},
  {...assistant,content:[{type:"thinking",thinking:"",thinkingSignature:"opaque",redacted:true},{type:"text",text:"Answer",textSignature:"text-signature"},{type:"toolCall",id:"call",name:"source_read",arguments:{nested:[1,"two",null]},thoughtSignature:"tool-signature"}]},
  {...tool,content:[{type:"text",text:"source"},{type:"image",data:"AA==",mimeType:"image/png"}]}];
 input.session.rawHistory=new ConversationHistory(undefined,input.session.messages).snapshot();
 assert(validSavedUsage(input.metadata.usage));const id=await h.store.importSession(JSON.stringify(input));
 const imported=await h.store.get(id);assert.deepEqual(imported!.messages,input.session.messages);assert.deepEqual(imported!.rawHistory,input.session.rawHistory);
 assert.deepEqual((await h.store.getMetadata(id))!.usage,zero());assert.equal(await h.backend.get("memory-consent","choice"),"declined");
 const again=JSON.parse(await h.store.exportSession(id));assert.deepEqual(again.metadata.usage.cost,{input:0,output:0,cacheRead:0,cacheWrite:0,total:0});
});

test("truthy scalar costs and malformed numeric metadata are rejected before import writes",async()=>{
 const h=await setup();const alterations:Array<(value:any)=>void>=[
  ...[0,0.0001,"0",[],null,{}].map(cost=>(value:any)=>{value.metadata.usage.cost=cost}),
  ...[-1,"0",null].map(total=>(value:any)=>{value.metadata.usage.cost.total=total}),
  ...[-1,1.5,"1",null,Number.MAX_SAFE_INTEGER+1].map(input=>(value:any)=>{value.metadata.usage.input=input}),
  value=>{value.session.revision="1"},value=>{value.session.revision=-1},value=>{value.session.lastModified="not a date"},value=>{value.metadata.messageCount=-1},value=>{value.metadata.messageCount="3"},value=>{value.metadata.thinkingLevel="invalid"},value=>{value.metadata.createdAt="not a date"},
  value=>{value.session.messages[1].usage.cost=0.0001},value=>{value.session.messages[1].usage.output=-1},value=>{value.session.messages[0].timestamp="invalid"},
 ];
 for(const alter of alterations){const input=structuredClone(h.exported);alter(input);await assert.rejects(h.store.importSession(JSON.stringify(input)),/Invalid/);assert.deepEqual(await h.backend.keys("sessions"),["original"])}
});

test("corrupt legacy records fail restoration without rewriting evidence or changing declined consent",async()=>{
 const h=await setup();
 for(const target of["active","raw"]){const broken={...structuredClone(h.data),revision:1};if(target==="active")broken.messages[1]=malformed[0];else broken.rawHistory.records[1].message=malformed[1];
  await h.backend.set("sessions","original",broken);await assert.rejects(h.store.get("original"),/Invalid/);
  assert.deepEqual(await h.backend.get("sessions","original"),broken);assert.equal(await h.backend.get("memory-consent","choice"),"declined");
  assert.deepEqual(JSON.parse(await h.store.exportSession("original")).session,broken,"raw export remains available for recovery");
 }
 const malformedMeta={...h.meta,usage:{...zero(),cost:0.0001}};await h.backend.set("sessions-metadata","original",malformedMeta);
 await assert.rejects(h.store.getMetadata("original"),/Invalid conversation metadata/);assert.deepEqual(await h.backend.get("sessions-metadata","original"),malformedMeta);
 const listed=await h.store.getAllMetadata();assert.equal(listed.length,1);assert.equal(validSessionMetadata(listed[0]),false);assert.deepEqual(JSON.parse(await h.store.exportSession("original")).metadata,malformedMeta,"damaged metadata remains exportable for repair");
});

test("transcript formatting and consent projection reject malformed blocks explicitly without normalizing them",()=>{
 for(const bad of malformed){const before=structuredClone(bad);
  assert.throws(()=>formatTranscript([bad]as any),error=>error instanceof Error&&!(error instanceof TypeError)&&/Invalid conversation/.test(error.message));
  assert.throws(()=>withoutPersonalMemory([bad]as any),/Invalid conversation/);assert.deepEqual(bad,before);
  assert.throws(()=>new ConversationHistory(undefined,[bad]as any),/Invalid/);
 }
 assert.equal(formatTranscript([user]as any),"[USER]\nordinary statement");
});

test("malformed saves and queued legacy memory messages fail before publication",async()=>{
 const h=await setup();await assert.rejects(h.store.save({...h.data,messages:[malformed[0]]},h.meta,1),/Invalid/);assert.equal((await h.store.get("original"))!.revision,1);
 const pipeline={buffers:{audit:[],memory:[],summary:[]},flags:[],runningContext:[],sttLexicon:{autoReplace:[],mistranscriptions:[]},generation:0,
  jobs:[{id:"job",sessionKey:"original",generation:0,isVoiceTurn:false,messages:[malformed[1]],stages:{audit:"pending",memory:"pending",summary:"pending"}}]};
 assert.throws(()=>validatePipelineState(pipeline),/Invalid memory coverage message content/);
});


test("compressed attachment imports fail before either session store changes", async()=>{
 const h=await setup();const zip=new JSZip();zip.file("document.xml","x".repeat(40*1024*1024+1));
 const bytes=await zip.generateAsync({type:"uint8array",compression:"DEFLATE"});
 const attachment={id:"bomb",type:"document",fileName:"fixture.docx",mimeType:"application/vnd.openxmlformats-officedocument.wordprocessingml.document",size:bytes.length,content:Buffer.from(bytes).toString("base64")};
 const message={role:"user-with-attachments",content:"Read this",timestamp:1,attachments:[attachment]};
 for(const target of["active","raw"]){
  const input=structuredClone(h.exported);if(target==="active")input.session.messages=[message];else input.session.rawHistory.records[0].message=message;
  await assert.rejects(h.store.importSession(JSON.stringify(input)),/expansion/);
  assert.deepEqual(await h.backend.keys("sessions"),["original"]);assert.deepEqual(await h.backend.keys("sessions-metadata"),["original"]);
 }
});


test("legacy XLS imports retain correctly labelled and previously mislabeled original bytes", async()=>{
 const h=await setup();const XLSX=await import('xlsx');const workbook=XLSX.utils.book_new();XLSX.utils.book_append_sheet(workbook,XLSX.utils.aoa_to_sheet([['Retained cell',42]]),'Sheet1');
 const content=XLSX.write(workbook,{bookType:'biff8',type:'base64'});
 for(const mimeType of['application/vnd.ms-excel','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet']){
  const input=structuredClone(h.exported);const attachment={id:'legacy',type:'document',fileName:'fixture.xls',mimeType,content,size:Buffer.from(content,'base64').length};
  input.session.messages=[{role:'user-with-attachments',content:'Read this',timestamp:1,attachments:[attachment]}];input.session.rawHistory=new ConversationHistory(undefined,input.session.messages).snapshot();
  const id=await h.store.importSession(JSON.stringify(input));assert.deepEqual((await h.store.get(id))!.messages,input.session.messages);
 }
});

test("tool-result images obey canonical base64 and resource limits before import or save", async()=>{
 const h=await setup();const image={type:'image',data:'YQ==',mimeType:'image/png'};
 const oversized=Buffer.alloc(20*1024*1024+1).toString('base64');
 const payloads=[
  [{...image,data:'YR=='}],
  [{...image,data:'YQ='}],
  [{...image,data:'!!!!'}],
  [{...image,data:oversized}],
  Array(11).fill(image),
 ];
 for(const content of payloads){
  const bad={...tool,content};
  for(const target of['active','raw']){
   const input=structuredClone(h.exported);if(target==='active')input.session.messages=[bad];else input.session.rawHistory.records[0].message=bad;
   await assert.rejects(h.store.importSession(JSON.stringify(input)),/Invalid/);
  }
  await assert.rejects(h.store.save({...h.data,messages:[bad]},h.meta,1),/Invalid/);
  assert.deepEqual(await h.backend.keys('sessions'),['original']);assert.deepEqual(await h.backend.keys('sessions-metadata'),['original']);
  assert.deepEqual(await h.backend.get('sessions','original'),{...h.data,revision:1});
 }
 const input=structuredClone(h.exported);input.session.messages=[{...tool,content:Array(10).fill(image)}];input.session.rawHistory=new ConversationHistory(undefined,input.session.messages).snapshot();
 const id=await h.store.importSession(JSON.stringify(input));assert.deepEqual((await h.store.get(id))!.messages,input.session.messages);
});
