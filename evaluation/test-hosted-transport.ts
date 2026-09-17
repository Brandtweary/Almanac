import assert from "node:assert/strict";
let attempted=0; let body:string|undefined;
globalThis.fetch=async()=>{attempted++;if(body!==undefined)return new Response(body,{headers:{"content-type":"text/event-stream"}});throw new Error("Synthetic connection closed before response");};
const {runStockCase}=await import("./stock.ts");
const {loadCreativeSuite}=await import("./creative.ts");
const r=await runStockCase(loadCreativeSuite().cases[0],{id:"fixture",contextWindow:100000,maxOutputTokens:128,reasoning:false,prices:{input:1,output:1,cacheRead:0,cacheWrite:0}},"synthetic-not-a-credential",{maxCompletions:1,timeoutMs:1000,spendAvailable:()=>true});
assert.equal(attempted,1);assert.equal(r.requests.length,1);assert.equal(r.providerReceipts.length,0);assert.equal(r.usageIncomplete,true);assert.equal(r.status,"transport_error");
console.log("A request without a Response retains unknown billing exposure; no network is used.");

body=`data: ${JSON.stringify({id:"fixture",choices:[{index:0,delta:{role:"assistant",content:"Hello."},finish_reason:"stop"}],usage:{prompt_tokens:10,completion_tokens:2,cost:0.00001}})}\n\n`;
for(const done of [false,true]){
 if(done)body+="data: [DONE]\n\n";
 const receipt=await runStockCase(loadCreativeSuite().cases[0],{id:"fixture",contextWindow:100000,maxOutputTokens:128,reasoning:false,prices:{input:1,output:1,cacheRead:0,cacheWrite:0}},"synthetic-not-a-credential",{maxCompletions:1,timeoutMs:1000,spendAvailable:()=>true});
 assert.equal(receipt.providerReceipts[0].protocolDone,done);
 assert.equal(receipt.usageIncomplete,!done);
 assert.equal(receipt.status==="transport_error",!done);
}
console.log("Usage without a framed DONE marker remains incomplete.");
