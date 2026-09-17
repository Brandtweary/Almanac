import assert from "node:assert/strict";
import { test } from "node:test";
import { PipelineRuntime, type PipelineDeps, type PipelineAgentName } from "../src/pipeline.js";
import { Graph } from "../src/kg/graph.js";
import { validatedTokenUsage } from "../src/token-usage.js";
import type { ConversationArchive } from "../src/conversation-history.js";
import type { MemoryArchiveRecord } from "../src/memory-archive.js";
const message = (text="Finished", output=1) => ({role:"assistant",content:[{type:"text",text}],stopReason:"stop",usage:{input:1,output}}) as any;
const user = {role:"user",content:"I said snocking. The old description is wrong.",timestamp:1} as any;
const role = (text:string):PipelineAgentName => text.includes("## Your role: audit")?"audit":text.includes("## Your role: summary")?"summary":"memory";
const execute = (context:any,name:string,args:unknown) => context.tools.find((tool:any)=>tool.name===name).execute("call",args,undefined,undefined);
async function finish(context:any,text?:string) { if(context.tools.some((tool:any)=>tool.name==="summary_draft")) await execute(context,"summary_draft",text?{operation:"store",text}:{operation:"abstain",reason:"No new facts"}); else await execute(context,"memory_finish",{outcome:"no-op",reason:"No changes"}); }
async function setup(loop?:PipelineDeps["runLoop"], options:{values?:Map<string,unknown>; outputBudget?:number; graph?:Graph}={}) {
 const values=options.values??new Map<string,unknown>(); let graph=options.graph??Graph.empty(); const archived:MemoryArchiveRecord[]=[]; const errors:unknown[]=[];
 let saved={revision:1,archive:{version:1,complete:true,records:[{id:"raw-one",message:user}]} as ConversationArchive};
 const backend={async get<T>(store:string,key:string){return values.get(`${store}/${key}`) as T|undefined},async set(store:string,key:string,value:unknown){values.set(`${store}/${key}`,structuredClone(value))},async transaction<T>(_a:string[],_b:string,fn:(tx:any)=>Promise<T>){return fn(this)}};
 const runtime=new PipelineRuntime({backend,getGraph:()=>graph,setGraph:g=>{graph=g},publishMemory:async(asset,state,records,guard)=>{guard?.();await backend.set("lexicon","terms",asset);await backend.set("pipeline","state",state);archived.push(...structuredClone(records??[]))},
 appendArchive:async(records,guard)=>{guard?.();archived.push(...structuredClone(records))},getRawHistory:async()=>structuredClone(saved),embed:async()=>null,getModel:()=>({} as any),getBaseUrl:()=>"invalid",getModelId:()=>"fixture",getAuth:()=>"secret-never-archived",getConsent:()=>"granted",addCost:()=>{},onStateChange:()=>{},onActivity:()=>{},onError:error=>errors.push(error),measureContext:async()=>1,getRoleInputBudget:()=>1000000,getRoleOutputBudget:()=>options.outputBudget??1000,
 runLoop:loop??(async(_prompt,context)=>{await finish(context);return[message()]})});
 await runtime.init();runtime.startSession("session");return{runtime,values,archived,errors,graph:()=>graph,saved:()=>saved,setSaved:(value:typeof saved)=>{saved=value}};
}
async function inspect(context:any,collection:string,id:string){return JSON.parse(JSON.parse((await execute(context,"memory_inspect",{collection,id})).content[0].text).text)}

test("audit findings cross declared edges only, with exact source and explicit producer outcome",async()=>{
 const seed=Graph.empty();const term=seed.getOrCreate("orchard","Old description.");const order:string[]=[];
 const h=await setup(async(prompt,context)=>{const name=role(String((prompt[0]as any).content));order.push(name);
  if(name==="audit"){
   await execute(context,"log_mistranscription",{spoken:"snacking",transcribed:"snocking",kind:"phonetic"});
   await execute(context,"audit_handoff",{kind:"spelling",spoken:"snacking",transcribed:"snocking",utteranceId:"voice-one",evidence:[{recordId:"raw-one",quote:"snocking"}]});
   await execute(context,"audit_handoff",{kind:"stale-description",termId:term.id,reason:"User corrected prior claim",evidence:[{recordId:"raw-one",quote:"The old description is wrong."}]});
   await execute(context,"memory_finish",{outcome:"completed",reason:"Supported findings"});
  }else{const upstream=await inspect(context,"handoffs","audit");assert.equal(upstream.sessionKey,"session");assert.equal(upstream.outcome.kind,"completed");assert.equal(upstream.findings.length,name==="memory"?2:1);assert(upstream.findings.every((finding:any)=>finding.evidence[0].recordId==="raw-one"));await finish(context,name==="summary"?"The user discussed snacking.":undefined)}
  return[message()];
 },{graph:seed});
 await h.runtime.onTurnEndHistory({sessionKey:"session",...h.saved()},true,{utteranceId:"voice-one",rawText:user.content,correctedText:user.content});await h.runtime.whenIdle();
 assert.deepEqual(order,["audit","memory","summary"]);assert.equal(h.runtime.snapshot().jobs![0].outcomes?.summary?.kind,"completed");
 assert(h.archived.some(row=>row.kind==="outcome"&&row.status==="complete"));assert(!JSON.stringify(h.archived).includes("secret-never-archived"));
});

test("wrong-source and unsupported spelling claims fail while audit can repair; failed producer supplies nothing",async()=>{
 const seen:string[]=[];const h=await setup(async(prompt,context)=>{const name=role(String((prompt[0]as any).content));seen.push(name);
  await assert.rejects(execute(context,"audit_handoff",{kind:"spelling",spoken:"snacking",transcribed:"snocking",utteranceId:"voice-one",evidence:[{recordId:"raw-one",quote:"snocking"}]}),/accepted/);
  await assert.rejects(execute(context,"audit_handoff",{kind:"stale-description",termId:"missing",reason:"wrong",evidence:[{recordId:"another-job",quote:"snocking"}]}),/admitted/);
  throw new Error("Provider failed before audit completion");});
 await h.runtime.onTurnEndHistory({sessionKey:"session",...h.saved()},false);await h.runtime.whenIdle();
 assert.deepEqual(seen,["audit"]);assert.equal(h.runtime.snapshot().jobs![0].handoffs,undefined);assert.equal(h.runtime.snapshot().jobs![0].stages.summary,"pending");
});

test("summary can repair invalid drafts and terminal prose never replaces the stored entry",async()=>{
 const h=await setup(async(prompt,context)=>{
  if(role(String((prompt[0]as any).content))==="summary"){
   await assert.rejects(execute(context,"summary_draft",{operation:"check",text:" "}),/words/);
   await assert.rejects(execute(context,"summary_draft",{operation:"store",text:"word ".repeat(8001)}),/words/);
   await execute(context,"summary_draft",{operation:"check",text:"Verified draft."});
   await execute(context,"summary_draft",{operation:"store",text:"Verified draft."});
  }else await finish(context);
  return[message("This terminal text must not be stored")];});
 h.runtime.onTurnEnd(()=>[user],false);await h.runtime.whenIdle();assert.equal(h.runtime.getRunningContext()[0].text,"Verified draft.");
 const stored=h.archived.find(row=>row.kind==="summary");assert.equal((stored!.payload as any).text,"Verified draft.");
});

test("refusal is outstanding, differs from no-op, and reload does not retry it implicitly",async()=>{
 const h=await setup(async(_prompt,context)=>{await execute(context,"memory_finish",{outcome:"refused",reason:"Cannot establish evidence"});return[message()]});
 h.runtime.onTurnEnd(()=>[user],false);await h.runtime.whenIdle();assert.equal(h.runtime.snapshot().jobs![0].stages.audit,"refused");assert.equal(h.runtime.snapshot().jobs![0].outcomes?.audit?.kind,"refused");
 let calls=0;const reloaded=await setup(async(_prompt,context)=>{calls++;await finish(context);return[message()]},{values:h.values});reloaded.runtime.resumePending();await reloaded.runtime.whenIdle();assert.equal(calls,0);
 reloaded.runtime.retryPending();await reloaded.runtime.whenIdle();assert.equal(calls,3);assert.equal(reloaded.runtime.snapshot().jobs![0].outcomes?.audit?.kind,"no-op");
});

test("archive jobs contain no transcript copies and later appends do not retarget their immutable range",async()=>{
 const h=await setup();await h.runtime.onTurnEndHistory({sessionKey:"session",...h.saved()},false);await h.runtime.whenIdle();const job=h.runtime.snapshot().jobs![0];
 assert.deepEqual(job.messages,[]);assert.equal(job.history!.lastId,"raw-one");assert(!JSON.stringify(job).includes(user.content));
 h.setSaved({revision:2,archive:{...h.saved().archive,records:[...h.saved().archive.records,{id:"raw-two",message:{...user,content:"Later turn"}}]}});
 await h.runtime.onTurnEndHistory({sessionKey:"session",...h.saved()},false);await h.runtime.whenIdle();assert.equal(h.runtime.snapshot().jobs![1].coverageStart,1);
 const wrong={...h.saved(),archive:{...h.saved().archive,records:[{id:"raw-one",message:{...user,content:"Changed"}},h.saved().archive.records[1]]}};
 await assert.rejects(h.runtime.onTurnEndHistory({sessionKey:"session",...wrong},false),/changed/);
});

test("missing summary decision fails instead of acknowledging terminal prose",async()=>{
 const h=await setup(async(prompt,context)=>{if(role(String((prompt[0]as any).content))!=="summary")await finish(context);return[message("Perhaps a summary")]});
 h.runtime.onTurnEnd(()=>[user],false);await h.runtime.whenIdle();assert.equal(h.runtime.snapshot().jobs![0].stages.summary,"failed");assert.equal(h.runtime.getRunningContext().length,0);
});

test("actual output allowance replaces the inherited twelve-call ceiling and malformed usage fails closed",async()=>{
 const h=await setup(async(prompt,context,_config,emit)=>{await finish(context);if(role(String((prompt[0]as any).content))!=="audit")return[message()];const messages=Array.from({length:15},()=>message());for(const row of messages)await emit({type:"message_end",message:row});return messages},{outputBudget:20});
 h.runtime.onTurnEnd(()=>[user],false);await h.runtime.whenIdle();assert.equal(h.runtime.snapshot().jobs![0].stages.audit,"complete");
 const exhausted=await setup(async(_prompt,context)=>{await finish(context);return[message("Too much",21)]},{outputBudget:20});exhausted.runtime.onTurnEnd(()=>[user],false);await exhausted.runtime.whenIdle();assert.equal(exhausted.runtime.snapshot().jobs![0].outcomes?.audit?.kind,"budget-exhausted");
 for(const usage of [undefined,{input:1,output:NaN},{input:1,output:-1},{input:1,output:1.5},{input:1,output:0}])assert.throws(()=>validatedTokenUsage(usage,"pi",true));
 const unknown=await setup(async(_prompt,context)=>{await finish(context);return[{...message(),usage:undefined}]});unknown.runtime.onTurnEnd(()=>[user],false);await unknown.runtime.whenIdle();assert.equal(unknown.runtime.snapshot().jobs![0].stages.audit,"failed");
});

test("completed archive coverage survives rotation of active job receipts",async()=>{
 const h=await setup();await h.runtime.onTurnEndHistory({sessionKey:"session",...h.saved()},false);await h.runtime.whenIdle();
 const snapshot=h.runtime.snapshot();snapshot.jobs=[];h.runtime.restore(snapshot);
 await h.runtime.onTurnEndHistory({sessionKey:"session",...h.saved()},false);await h.runtime.whenIdle();assert.equal(h.runtime.snapshot().jobs!.length,0);
 h.setSaved({revision:2,archive:{...h.saved().archive,records:[...h.saved().archive.records,{id:"raw-two",message:{...user,content:"New input"}}]}});
 await h.runtime.onTurnEndHistory({sessionKey:"session",...h.saved()},false);await h.runtime.whenIdle();assert.equal(h.runtime.snapshot().jobs![0].coverageStart,1);
});

test("truncation, interrupted inference and cancellation retain distinct outcomes",async()=>{
 for(const [stopReason,kind]of[["length","budget-exhausted"],["aborted","transient"]]){
  const h=await setup(async(_prompt,context)=>{await finish(context);return[{...message(),stopReason}]});h.runtime.onTurnEnd(()=>[user],false);await h.runtime.whenIdle();assert.equal(h.runtime.snapshot().jobs![0].outcomes?.audit?.kind,kind);
 }
 let release!:()=>void;let entered!:()=>void;const ready=new Promise<void>(r=>entered=r);const wait=new Promise<void>(r=>release=r);
 const h=await setup(async(_prompt,context)=>{entered();await wait;await finish(context);return[message()]});h.runtime.onTurnEnd(()=>[user],false);await ready;
 const cancellation=h.runtime.cancel();release();await cancellation;assert.equal(h.runtime.snapshot().jobs!.length,0);assert(h.archived.some(row=>row.status==="cancelled"&&(row.payload as any).outcome.kind==="cancelled"));
});

test("attachment handoffs accept accompanying user text and reject uploaded source claims", async () => {
 const seed=Graph.empty(); const term=seed.getOrCreate("orchard","Old description."); let audited=false;
 const h=await setup(async(prompt,context)=>{
  if(role(String((prompt[0]as any).content))==="audit") {
   const evidence=await execute(context,"memory_inspect",{collection:"transcript",id:"raw-one"});
   assert.match(evidence.content[0].text,/user statement/);
   const claim=(quote:string)=>execute(context,"audit_handoff",{kind:"stale-description",termId:term.id,reason:"Changed description",evidence:[{recordId:"raw-one",quote}]});
   await assert.rejects(claim("The uploaded description is different."),/admitted user record/);
   await claim("My description has changed."); audited=true;
   await execute(context,"memory_finish",{outcome:"completed",reason:"Supported correction"});
  } else await finish(context);
  return [message()];
 },{graph:seed});
 h.setSaved({revision:1,archive:{version:1,complete:true,records:[{id:"raw-one",message:{role:"user-with-attachments",content:"My description has changed.",timestamp:1,
  attachments:[{id:"doc",type:"document",fileName:"report.txt",mimeType:"text/plain",size:4,content:"ZGF0YQ==",extractedText:"The uploaded description is different."}]}}]}});
 await h.runtime.onTurnEndHistory({sessionKey:"session",...h.saved()},false); await h.runtime.whenIdle();
 assert(audited); assert.equal(h.runtime.snapshot().jobs![0].stages.audit,"complete");
 assert.equal(h.runtime.snapshot().jobs![0].handoffs?.[0].evidence[0].role,"user");
});
