import assert from "node:assert/strict";
import {createAssistantMessageEventStream} from "@earendil-works/pi-ai";
import {runStockCase} from "./stock.ts";
import {loadStockCases} from "./stock-cases.ts";
import {FixtureLibrary} from "./library.ts";
import {validateEvidence} from "../src/corpus-tools.ts";
const cases=loadStockCases();assert(cases.length>=35);assert(new Set(cases.map(c=>c.id)).size===cases.length);
const fixture=cases.find(c=>c.id==="research.separate_warning")!;
const library=new FixtureLibrary(fixture.contexts!);for(const p of library.passages)validateEvidence(p);
assert.throws(()=>library.read({document_id:library.passages[0].document_id,passage_id:"invented"}));
const profile={id:"fixture",contextWindow:16384,maxOutputTokens:2048,reasoning:false};
let step=0;
const receipt=await runStockCase(fixture,profile,"unused",{maxCompletions:5,timeoutMs:10000,spendAvailable:()=>true,stream:(_model,context)=>{
 const stream=createAssistantMessageEventStream();let content:any[];let stopReason:any;
 if(step++===0){content=[{type:"toolCall",id:"search-1",name:"corpus_search",arguments:{query:"Alder pump"}}];stopReason="toolUse";}
 else if(step===2){const result=context.messages.findLast((m:any)=>m.role==="toolResult") as any;const data=JSON.parse(result.content[0].text);content=[{type:"toolCall",id:"read-1",name:"corpus_read",arguments:{document_id:data.hits[0].document_id,passage_id:data.hits[0].passage_id}}];stopReason="toolUse";}
 else {const result=context.messages.findLast((m:any)=>m.role==="toolResult") as any;const data=JSON.parse(result.content[0].text);content=[{type:"text",text:`A source [reference](corpus:${data.passages[0].passage_id}).`}];stopReason="stop";}
 const message:any={role:"assistant",content,api:"openai-completions",provider:"fixture",model:"fixture",usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},stopReason,timestamp:Date.now()};
 queueMicrotask(()=>{stream.push({type:"done",reason:stopReason,message});stream.end(message);});return stream;
}});
assert.equal(receipt.stopReason,"stop",receipt.error);assert.equal(receipt.status,"unadjudicated");assert(receipt.checks.every((c:any)=>c.passed));
assert.equal(receipt.libraryRequests[0].kind,"search");assert.equal(receipt.libraryRequests[1].kind,"read");assert.equal(receipt.toolCalls.length,2);
const off=cases.find(c=>c.id==="memory.consent-off")!;
let requests=0;await runStockCase(off,profile,"unused",{maxCompletions:1,timeoutMs:1000,spendAvailable:()=>true,stream:()=>{requests++;throw new Error("forbidden");}});assert.equal(requests,0);
console.log(`Stock manifest (${cases.length} cases), actual Pi tool loop, source handles and consent verified without network.`);

// Canonical identity belongs to the retained ledger, not generated summary bytes.
const {compactContext}=await import("../src/oracle-context.ts");
const {EvidenceLedger,createCorpusTools}=await import("../src/corpus-tools.ts");
const {withFixtureLibrary}=await import("./stock.ts");
const canonical=library.passages[0];const beforeLedger=new EvidenceLedger();beforeLedger.remember([canonical]);
const oldMessages:any[]=[{role:"user",content:"Read the earlier manual.",timestamp:1},{role:"assistant",content:[{type:"text",text:"Earlier answer."}],timestamp:2},{role:"user",content:"Now continue.",timestamp:3}];
const compacted=await compactContext({messages:oldMessages,ledger:beforeLedger.message(),inputBudget:50,summaryInputBudget:1000,convert:messages=>messages as any,measure:async messages=>messages.some(m=>m.role==="compactionSummary")?1:100,measureSummary:async()=>1,summarize:async()=>"Summary with a changed inventory label pump‑v2‑p17.",isCurrent:()=>true});
const restoredLedger=new EvidenceLedger();restoredLedger.restore(compacted);
assert.equal(restoredLedger.resolve(canonical.passage_id)?.source_revision,canonical.source_revision);
const readTool=createCorpusTools(restoredLedger).find(t=>t.name==="corpus_read")!;
const restored=await withFixtureLibrary(library,()=>readTool.execute("after-compaction",{document_id:canonical.document_id,passage_id:canonical.passage_id},new AbortController().signal));
assert.equal((restored.details as any).passages[0].passage_id,canonical.passage_id);
console.log("Compaction summary identity mutation cannot alter retained source handles or subsequent source reads.");
