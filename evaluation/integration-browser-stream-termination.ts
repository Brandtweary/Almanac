/** A streamed reply that never sends [DONE] is a truncated transport, not a completed request. */
import assert from "node:assert/strict";
import {mkdtempSync,rmSync,readFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {startBrowserBridge} from "./browser-bridge.ts";
import {FixtureLibrary} from "./library.ts";
const originalFetch=globalThis.fetch;
const dir=mkdtempSync(join(tmpdir(),"browser-stream-"));
const candidate={model:"fixture",name:"fixture",maxInputTokens:4096,maxOutputTokens:100,maxStageOutputTokens:200,maxRequests:10,maxCostUSD:1,prices:{input:1,output:2,cacheRead:3,cacheWrite:4},providerRouting:{only:["fixture-provider"]}};
let bridge:Awaited<ReturnType<typeof startBrowserBridge>>|undefined;
// Valid content AND a usage frame, then end of body: everything a completed
// stream carries except the one frame that says it completed.
const frames=[
 `data: ${JSON.stringify({id:"truncated",provider:"fixture-provider",choices:[{index:0,delta:{role:"assistant",content:"Partial answer"},finish_reason:null}]})}\n\n`,
 `data: ${JSON.stringify({id:"truncated",choices:[{index:0,delta:{},finish_reason:null}],usage:{prompt_tokens:8,completion_tokens:12,total_tokens:20,cost:0.0001}})}\n\n`,
];
try{
 globalThis.fetch=async()=>new Response(new ReadableStream({start(controller){for(const frame of frames)controller.enqueue(new TextEncoder().encode(frame));controller.close();}}),{status:200,headers:{"Content-Type":"text/event-stream"}});
 bridge=await startBrowserBridge({candidate,dist:dir,output:dir,apiKey:"fake",library:new FixtureLibrary([]),priorBudget:{ceilingUSD:1,priorReportedUSD:0,priorUnknownReserveUSD:0}});
 const result=await originalFetch(bridge.url+"/v1/chat/completions",{method:"POST",headers:{"Content-Type":"application/json","x-request-id":"truncated"},body:JSON.stringify({messages:[],stream:true})});
 await result.text();
 const record=bridge.requests.find(r=>r.id==="truncated")!;
 assert.equal(record.state,"failed","a stream without its terminal frame must never reach completed");
 assert.notEqual(record.state,"completed");
 assert.equal(JSON.parse(readFileSync(join(dir,`request-${Buffer.from("truncated").toString("hex")}.json`),"utf8")).state,"failed");
 assert.equal(bridge.unknownBilling,true,"a truncated stream leaves billing unresolved");
 console.log("A streamed reply carrying usage but no [DONE] fails its request rather than completing it.");
}finally{globalThis.fetch=originalFetch;await bridge?.close();rmSync(dir,{recursive:true,force:true});}
