import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { loadStockCases } from "./stock-cases.ts";
import { runtimeDigests, prepareLocalStock } from "./local-stock.ts";
const runtime=JSON.parse(readFileSync(new URL("../deploy/glm47-flash-vllm-candidate.json",import.meta.url),"utf8"));
const profile={id:"local-fixture",model:{id:"fixture-local",name:"Fixture local",contextWindow:20000,maxTokens:100,reasoning:false,input:["text"],sampling:{temperature:1,top_p:.95,top_k:64},...runtimeDigests(runtime)},roles:Object.fromEntries(["chat","audit","memory","summary","compaction"].map(role=>[role,{maxInputTokens:19000,maxOutputTokens:100,maxStageOutputTokens:15}])),limits:{queueTimeoutMs:1000,executionTimeoutMs:1000}};
let mode="research",counts=17,step=0;const sent:any[]=[];
globalThis.fetch=async(input,init)=>{
 const url=String(input instanceof Request?input.url:input);
 assert(url.startsWith("http://127.0.0.1:18790/v1/"),`Unexpected network destination ${url}`);
 if(url.endsWith("/profile"))return Response.json({qualificationMode:true,ready:false,profile});
 const body=init?.body?JSON.parse(String(init.body)):input instanceof Request?await input.json():{};
 if(url.endsWith("/tokenize"))return Response.json({tokens:counts});
 if(url.includes("/requests/"))return Response.json({state:"complete"});
 assert(url.endsWith("/chat/completions"));
 const headers=new Headers(init?.headers??(input instanceof Request?input.headers:undefined));
 assert.match(headers.get("X-Conversation-Id")??"",/^[A-Za-z0-9_-]{1,128}$/);
 sent.push(body);step++;
 let delta:any,finish="tool_calls";
 const call=(name:string,args:unknown)=>({role:"assistant",tool_calls:[{index:0,id:`tool-${step}`,type:"function",function:{name,arguments:JSON.stringify(args)}}]});
 if(mode==="stage")delta=call("memory_inspect",{collection:"transcript"});
 else if(step===1)delta=call("corpus_search",{query:"Alder pump"});
 else if(step===2){const result=JSON.parse(body.messages.at(-1).content);delta=call("corpus_read",{document_id:result.hits[0].document_id,passage_id:result.hits[0].passage_id});}
 else {const result=JSON.parse(body.messages.at(-1).content);delta={role:"assistant",content:`A source [reference](corpus:${result.passages[0].passage_id}).`};finish="stop";}
 const usage={prompt_tokens:mode==="mismatch"?18:17,completion_tokens:Math.min(10,body.max_tokens),total_tokens:27};
 return new Response(`data: ${JSON.stringify({id:`local-${step}`,choices:[{index:0,delta,finish_reason:finish}],usage})}\n\ndata: [DONE]\n\n`,{headers:{"content-type":"text/event-stream"}});
};
const runner=await prepareLocalStock("http://127.0.0.1:18790/v1",runtime);
const cases=loadStockCases(),fixture=cases.find(c=>c.id==="research.separate_warning")!;
function reset(next:string){mode=next;step=0;sent.length=0;counts=17;}
test("local stock uses production token admission and Pi tool loop with native usage and exact runtime identity",async()=>{
 reset("research");const r=await runner.run(fixture,{maxCompletions:5,timeoutMs:10000});
 assert.equal(r.status,"unadjudicated",r.error);assert(r.checks.every((c:any)=>c.passed));
 assert.equal(sent.length,3);assert.equal(r.metrics.inputTokens,51);assert.equal(r.metrics.outputTokens,30);assert.equal(r.metrics.costUSD,0);assert.equal(r.usageIncomplete,false);
 assert.equal(r.localRuntime.runtime.serving.image,runtime.serving.image);assert.deepEqual(r.rubric,fixture.rubric);
 assert.equal(r.tokenMeasurements.length,3);assert.equal(r.providerReceipts[0].usage.prompt_tokens,17);
 assert(sent.every(body=>body.model==="fixture-local"&&body.temperature===1&&body.top_p===.95&&body.top_k===64));assert.equal(r.libraryRequests[0].kind,"search");assert.equal(r.libraryRequests[1].kind,"read");
});
test("native prompt count mismatch is an evaluator failure, never a scored pass",async()=>{
 reset("mismatch");const r=await runner.run(fixture,{maxCompletions:5,timeoutMs:10000});
 assert.equal(r.status,"evaluator_error");assert.equal(r.checks.find((c:any)=>c.id==="native_token_count_parity").passed,false);
});
test("local role input overflow prevents any generation HTTP call",async()=>{
 reset("research");counts=20001;const r=await runner.run(fixture,{maxCompletions:5,timeoutMs:10000});
 assert.equal(sent.length,0);assert.notEqual(r.status,"unadjudicated");assert.equal(r.tokenMeasurements.length,1);
});
test("local retained roles reserve cumulative output before each completion",async()=>{
 reset("stage");const role=cases.find(c=>c.roleCase?.role==="memory"&&c.roleCase.memoryConsent)!;
 const r=await runner.run(role,{maxCompletions:5,timeoutMs:10000});
 assert.deepEqual(sent.map(body=>body.max_tokens),[15,5]);assert.equal(r.metrics.outputTokens,15);assert.notEqual(r.status,"unadjudicated");
});
test("runtime and tokenizer identities cannot drift silently",async()=>{
 const bad=structuredClone(runtime);bad.files.find((f:any)=>f.path==="tokenizer.json").sha256="a".repeat(64);
 await assert.rejects(prepareLocalStock("http://127.0.0.1:18790/v1",bad),/tokenizerDigest/);
 await assert.rejects(prepareLocalStock("https://example.com/v1",runtime),/loopback/);
});

test("measurement mode counts initial retained-role prompts without model generation",async()=>{
 reset("research");const role=cases.find(c=>c.roleCase?.role==="memory"&&c.roleCase.memoryConsent)!;
 const r=await runner.run(role,{maxCompletions:5,timeoutMs:10000,measureOnly:true});
 assert.equal(sent.length,0);assert.equal(r.status,"measurement_only");assert.equal(r.measurement.role,"memory");assert.deepEqual(r.measurement.counts,[17]);assert.equal(r.measurement.fits,true);
});
