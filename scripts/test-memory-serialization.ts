import assert from "node:assert/strict";
import { test } from "node:test";
import { PipelineRuntime } from "../src/pipeline.js";
import { Graph } from "../src/kg/graph.js";
import { loadReleaseProfile, proxyChatModel } from "../src/local-model.js";
import { serializeModelRequest } from "../src/oracle-runtime.js";
const profile={id:"serialization-fixture",model:{id:"fixture",name:"Fixture",contextWindow:131072,maxTokens:2048,reasoning:true,input:["text"]},roles:Object.fromEntries(["chat","audit","memory","summary","compaction"].map(role=>[role,{maxInputTokens:129024,maxOutputTokens:2048,maxStageOutputTokens:16384,thinkingLevel:"high"}])),limits:{queueTimeoutMs:1000,executionTimeoutMs:1000}};
const zeroUsage=()=>({input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}});

test("every stage inspector serializes its measurement envelope with the installed provider",async()=>{
 const originalFetch=globalThis.fetch,originalNow=Date.now;const measured:any[]=[];const roles:string[]=[];
 globalThis.fetch=async(input,init)=>{if(String(input).endsWith('/profile'))return Response.json({ready:true,profile});assert(String(input).endsWith('/tokenize'),'serialization must never reach inference');measured.push(JSON.parse(String(init?.body)));return Response.json({tokens:100});};
 // Equal timestamps force the provider's prior-assistant usage path, rather than
 // allowing a newer user timestamp to accidentally bypass the incomplete record.
 Date.now=()=>123456789;
 try{
  await loadReleaseProfile();const values=new Map<string,unknown>();let graph=Graph.empty();
  const backend={async get<T>(store:string,key:string){return values.get(`${store}/${key}`) as T|undefined},async set(store:string,key:string,value:unknown){values.set(`${store}/${key}`,structuredClone(value))},async transaction<T>(_stores:string[],_mode:string,fn:(tx:any)=>Promise<T>){return fn(this)}};
  const runtime=new PipelineRuntime({backend,getGraph:()=>graph,setGraph:value=>{graph=value},publishMemory:async(asset,state)=>{await backend.set('lexicon','terms',asset);await backend.set('pipeline','state',state)},getModel:proxyChatModel,getModelId:()=>profile.model.id,getBaseUrl:()=>'',getAuth:()=>'',getConsent:()=> 'granted',embed:async()=>null,addCost:()=>{},onStateChange:()=>{},onActivity:()=>{},runLoop:async(messages,context)=>{
   const prompt=String((messages[0]as any).content);const role=prompt.includes('## Your role: summary agent')?'summary':prompt.includes('## Your role: audit agent')?'audit':'memory';roles.push(role);
   const inspector=context.tools!.find(t=>t.name==='memory_inspect')!;
   for(const args of[{collection:'memory',query:'compost'},{collection:'working_summary',id:'current'}]){
    const result=await inspector.execute('inspector-probe',args,undefined,undefined);assert.match(JSON.stringify(result),/"complete":true|\\"complete\\":true/);
   }
   const summary=context.tools!.find(t=>t.name==='summary_draft');
   if(summary)await summary.execute('abstain',{operation:'abstain',reason:'No durable fact'},undefined,undefined);
   else await context.tools!.find(t=>t.name==='memory_finish')!.execute('finish',{outcome:'no-op',reason:'No durable fact'},undefined,undefined);
   return [{role:'assistant',api:'openai-completions',provider:'local',model:'fixture',content:[{type:'text',text:'No changes'}],stopReason:'stop',timestamp:Date.now(),usage:{...zeroUsage(),input:1,output:1,totalTokens:2}}] as any;
  }});
  await runtime.init();runtime.startSession('probe');runtime.onTurnEnd(()=>[{role:'user',content:'Why is compost wet?',timestamp:1}],false);await runtime.whenIdle();
  assert.deepEqual(roles,['audit','memory','summary']);assert.deepEqual(runtime.snapshot().jobs![0].stages,{audit:'complete',memory:'complete',summary:'complete'});
  for(const role of roles)assert(measured.some(p=>p.role===role&&p.messages.some((m:any)=>m.role==='tool'&&m.tool_call_id==='inspector-probe')),`${role} measures actual tool-result envelope`);
 }finally{globalThis.fetch=originalFetch;Date.now=originalNow}
});

test("pre-payload serialization failures retain their actual diagnostic",async()=>{
 const original=globalThis.fetch;globalThis.fetch=async()=>Response.json({ready:true,profile});
 try{await loadReleaseProfile();await assert.rejects(serializeModelRequest({messages:[{role:'assistant',content:[],stopReason:'stop',timestamp:1} as any]}),/Could not serialize model context:.*totalTokens/)}finally{globalThis.fetch=original}
});
