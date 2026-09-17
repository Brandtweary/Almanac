import assert from "node:assert/strict";
let attempted=0;
globalThis.fetch=async()=>{attempted++;throw new Error("Synthetic connection closed before response");};
const {runStockCase}=await import("./stock.ts");
const {loadCreativeSuite}=await import("./creative.ts");
const r=await runStockCase(loadCreativeSuite().cases[0],{id:"fixture",contextWindow:100000,maxOutputTokens:128,reasoning:false,prices:{input:1,output:1,cacheRead:0,cacheWrite:0}},"synthetic-not-a-credential",{maxCompletions:1,timeoutMs:1000,spendAvailable:()=>true});
assert.equal(attempted,1);assert.equal(r.requests.length,1);assert.equal(r.providerReceipts.length,0);assert.equal(r.usageIncomplete,true);assert.equal(r.status,"transport_error");
console.log("A request without a Response retains unknown billing exposure; no network is used.");
