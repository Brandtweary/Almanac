import assert from "node:assert/strict";
import { test } from "node:test";
import { IDBFactory, IDBKeyRange, IDBObjectStore } from "fake-indexeddb";
import { SettingsStore } from "../src/pi-web-ui/storage/stores/settings-store.js";
import { IndexedDBStorageBackend } from "../src/pi-web-ui/storage/backends/indexeddb-storage-backend.js";
import { validAttachments, base64Bytes, MAX_ATTACHMENTS, MAX_ATTACHMENT_BYTES, MAX_EXTRACTED_TEXT_BYTES } from "../src/attachment-limits.js";
import { validUserMessage } from "../src/user-messages.js";
import { assertDocumentBudget } from "../src/pi-web-ui/utils/document-budget.js";
import { safe } from "../src/debug.js";
import JSZip from "jszip";
globalThis.indexedDB = new IDBFactory(); globalThis.IDBKeyRange = IDBKeyRange;
const attachment = {id:"a",type:"document",fileName:"a.txt",mimeType:"text/plain",size:1,content:"YQ=="};

test("attachment imports enforce canonical bytes, metadata and expansion limits", () => {
 assert(validAttachments([attachment]));
 for(const patch of [{size:0},{size:1.2},{size:Number.MAX_SAFE_INTEGER+1},{content:"YR=="},{content:"!!!!"},{content:"YQ="},{content:"YQ==\n"},{preview:"invalid"},{preview:"A".repeat(4*Math.ceil(MAX_ATTACHMENT_BYTES/3)+4)},{extractedText:"a".repeat(MAX_EXTRACTED_TEXT_BYTES+1)},{extractedText:"€".repeat(Math.ceil(MAX_EXTRACTED_TEXT_BYTES/3))}]) {
  assert(!validUserMessage({role:"user-with-attachments",content:"",timestamp:1,attachments:[{...attachment,...patch}]} as any),JSON.stringify(Object.keys(patch)));
 }
 assert(!validAttachments(Array(MAX_ATTACHMENTS+1).fill(attachment)));
 assert.equal(base64Bytes("AA=="),1);assert.equal(base64Bytes("AAA="),2);assert.equal(base64Bytes("AAAA"),3);assert.equal(base64Bytes(""),0);
 assert.equal(base64Bytes("AA=A"),null);assert.equal(base64Bytes("A==="),null);
});

test("compressed document budget rejects actual oversized expansion", async()=>{
 const zip=new JSZip();zip.file("document.xml","x".repeat(40*1024*1024+1));
 const bytes=await zip.generateAsync({type:"arraybuffer",compression:"DEFLATE"});
 assert(bytes.byteLength<100000);await assert.rejects(assertDocumentBudget(bytes),/expansion/);
 const prefixed=new Uint8Array(bytes.byteLength+4);prefixed.set([1,2,3,4]);prefixed.set(new Uint8Array(bytes),4);await assert.rejects(assertDocumentBudget(prefixed.buffer,true),/expansion/);
 const small=new JSZip();small.file("document.xml","safe");await assertDocumentBudget(await small.generateAsync({type:"arraybuffer"}));
});

test("proxy writes roll back together and overlapping saves expose complete snapshots",async()=>{
 const settings=new SettingsStore();settings.setBackend(new IndexedDBStorageBackend({dbName:crypto.randomUUID(),version:1,stores:[settings.getConfig()]}));
 const old={enabled:false,url:"http://old.invalid"};await settings.setProxyConfig(old);
 const put=IDBObjectStore.prototype.put;
 IDBObjectStore.prototype.put=function(value:any,key?:IDBValidKey){if(key==="proxy.url")throw Error("injected second write failure");return put.call(this,value,key!)};
 try{await assert.rejects(settings.setProxyConfig({enabled:true,url:"http://new.invalid"}),/injected/)}finally{IDBObjectStore.prototype.put=put}
 assert.deepEqual(await settings.getProxyConfig(),old);
 const next={enabled:true,url:"http://next.invalid"},last={enabled:false,url:"http://last.invalid"};
 const seen=await Promise.all([settings.setProxyConfig(next),settings.getProxyConfig(),settings.setProxyConfig(last),settings.getProxyConfig()]);
 for(const snapshot of [seen[1],seen[3]])assert([old,next,last].some(pair=>JSON.stringify(pair)===JSON.stringify(snapshot)));
 assert.deepEqual(await settings.getProxyConfig(),last);
});

test("debug stringifier preserves missing values explicitly",()=>{
 for(const value of[undefined,Symbol("s"),()=>{}, {toJSON:()=>undefined}]) assert.equal(safe(value),"(not provided)");
 assert.equal(safe(1n),"1");
});

test("legacy .xls compound documents survive saved OOXML MIME while renamed ZIP remains bounded", async()=>{
 const XLSX=await import('xlsx');const book=XLSX.utils.book_new();XLSX.utils.book_append_sheet(book,XLSX.utils.aoa_to_sheet([['Legacy cell',42]]),'Sheet1');
 const data=XLSX.write(book,{bookType:'biff8',type:'array'});
 await assertDocumentBudget(data,true,true);
 await assert.rejects(assertDocumentBudget(data,true,false),/zip|central directory/i);
 const zip=new JSZip();zip.file('bomb','x'.repeat(40*1024*1024+1));
 await assert.rejects(assertDocumentBudget(await zip.generateAsync({type:'arraybuffer',compression:'DEFLATE'}),true,true),/expansion/);
});
