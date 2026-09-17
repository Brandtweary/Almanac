/** Loopback integration with a fake hosted transport; never calls a provider. */
import assert from "node:assert/strict";
import {mkdtempSync,rmSync,readFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {startBrowserBridge} from "./browser-bridge.ts";
import {FixtureLibrary} from "./library.ts";
const originalFetch=globalThis.fetch;
const dir=mkdtempSync(join(tmpdir(),"browser-budget-"));
const candidate={model:"fixture",name:"fixture",maxInputTokens:4096,maxOutputTokens:100,maxStageOutputTokens:200,maxRequests:10,maxCostUSD:1,prices:{input:1,output:2,cacheRead:3,cacheWrite:4},providerRouting:{only:["fixture-provider"]}};
let calls=0;let observedPayload:any;let bridge:Awaited<ReturnType<typeof startBrowserBridge>>|undefined;
try{
 globalThis.fetch=async(_input,init)=>{
  calls++;const payload=JSON.parse(init!.body as string);observedPayload=payload;
  assert.deepEqual(payload.provider.only,["fixture-provider"]);assert.equal(payload.provider.max_price.prompt,4);
  const ledger=JSON.parse(readFileSync(join(dir,"budget-ledger.json"),"utf8"));
  assert.equal(ledger.entries.first.status,"reserved");assert.equal(ledger.entries.first.exposureUSD,(4096*4+100*2)/1e6);
  throw new Error("simulated disconnect after acceptance");
 };
 bridge=await startBrowserBridge({candidate,dist:dir,output:dir,apiKey:"fake",library:new FixtureLibrary([]),priorBudget:{ceilingUSD:1,priorReportedUSD:0,priorUnknownReserveUSD:0}});
 const result=await originalFetch(bridge.url+"/v1/chat/completions",{method:"POST",headers:{"Content-Type":"application/json","x-request-id":"first"},body:JSON.stringify({messages:[]})});
 assert.equal(result.status,503);await result.text();
 assert.deepEqual(observedPayload.provider.only,["fixture-provider"]);assert.equal(observedPayload.provider.max_price.prompt,4);
 const ledger=JSON.parse(readFileSync(join(dir,"budget-ledger.json"),"utf8"));assert.equal(ledger.reservedUSD,(4096*4+100*2)/1e6);assert.equal(ledger.entries.first.status,"settled");
 assert.equal(JSON.parse(readFileSync(join(dir,"request-6669727374.json"),"utf8")).state,"failed");
 const second=await originalFetch(bridge.url+"/v1/chat/completions",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({messages:[]})});await second.text();assert.equal(calls,1);
 console.log("Loopback bridge persists reservations before provider acceptance, retains unknown exposure and pins cache price/provider.");
}finally{globalThis.fetch=originalFetch;await bridge?.close();rmSync(dir,{recursive:true,force:true});}
