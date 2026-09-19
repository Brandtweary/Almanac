/** Stock scenarios over the production local admission, queue and stream transport. */
import {inspectCompletionStream} from "./stream-receipt.ts";
import { isDeepStrictEqual } from "node:util";
import { AsyncLocalStorage } from "node:async_hooks";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { createLocalStreamFn, serializeModelRequest, countRequestTokens } from "../src/oracle-runtime.ts";
import { loadReleaseProfile, proxyChatModel, releaseProfile, GATEWAY_BASE, type OracleRole } from "../src/local-model.ts";
import { objectDigest, type StockCase } from "./stock-cases.ts";
import type { CandidateProfile } from "./stock.ts";

export interface RuntimeIdentity {
 repo: string; revision: string; qualified: false;
 files: Array<{path:string;bytes:number;sha256:string}>;
 serving: {image:string;source_revision:string};
}
export function runtimeDigests(runtime: RuntimeIdentity) {
 if(runtime.qualified!==false || !/^[a-f0-9]{40}$/.test(runtime.revision) || !runtime.repo ||
  !/@sha256:[a-f0-9]{64}$/.test(runtime.serving?.image) || !/^[a-f0-9]{40}$/.test(runtime.serving.source_revision) ||
  !Array.isArray(runtime.files) || runtime.files.some(f=>!f.path || !Number.isSafeInteger(f.bytes)||f.bytes<1||!/^[a-f0-9]{64}$/.test(f.sha256))) throw new Error("Pinned candidate runtime identity required");
 const weights=runtime.files.filter(f=>f.path.endsWith(".safetensors")||f.path.endsWith(".gguf"));
 const tokenizer=runtime.files.find(f=>f.path==="tokenizer.json"),template=runtime.files.find(f=>f.path==="chat_template.jinja");
 if(!weights.length||!tokenizer||!template)throw new Error("Candidate requires weights, tokenizer and template identities");
 return {artifactDigest:objectDigest(weights.map(({path,bytes,sha256})=>({path,bytes,sha256})).sort((a,b)=>a.path.localeCompare(b.path))),tokenizerDigest:tokenizer.sha256,templateDigest:template.sha256};
}
interface Trace { counts:any[]; completions:any[]; pending:Promise<void>[] }
const traces=new AsyncLocalStorage<Trace>();
let installedGateway:string|undefined;
/** Route the browser's canonical service base to one explicit loopback gateway. */
function install(gateway:string) {
 const url=new URL(gateway);
 if(url.protocol!=="http:"||!["127.0.0.1","localhost","[::1]"].includes(url.hostname)||url.username||url.password||url.search||url.hash||!url.pathname.endsWith("/v1"))throw new Error("Explicit loopback HTTP /v1 gateway required");
 const base=url.href.replace(/\/$/,"");
 if(installedGateway){if(installedGateway!==base)throw new Error("Run different gateways in separate processes");return;}
 const network=globalThis.fetch; installedGateway=base;
 globalThis.fetch=async(input,init)=>{
  const request=input instanceof Request?input:undefined;
  const address=request?.url??String(input);
  if(!address.startsWith(GATEWAY_BASE+"/"))return network(input,init);
  const target=base+address.slice(GATEWAY_BASE.length);
  const body=init?.body?JSON.parse(String(init.body)):request?.body?await request.clone().json():undefined;
  const trace=traces.getStore();const completion=address.endsWith("/chat/completions");
  const row:any=completion?{request:body}:undefined;
  if(row)trace?.completions.push(row);
  let response:Response;
  try {response=await network(request?new Request(target,request):target,init);}
  catch(error){if(row){row.transportError=String(error);row.interrupted=true;}throw error;}
  if(address.endsWith("/tokenize")&&trace){const counted=await response.clone().json();trace.counts.push({request:body,httpStatus:response.status,...counted});}
  if(row){row.httpStatus=response.status;
   trace?.pending.push(response.clone().text().then(text=>{
    row.rawResponse=text;
    Object.assign(row,inspectCompletionStream(text));
   }).catch(error=>{row.interrupted=true;row.transportError=String(error);}));
  }
  return response;
 };
}
export async function prepareLocalStock(gateway:string,runtime:RuntimeIdentity){
 const digests=runtimeDigests(runtime);install(gateway);
 await loadReleaseProfile(); const profile=releaseProfile();
 for(const [key,value] of Object.entries(digests))if((profile.model as any)[key]!==value)throw new Error(`Gateway ${key} differs from pinned runtime`);
 const identity={runtime,profile:structuredClone(profile),gateway,modelDigests:digests};
 // Import after installing the local route: the fixture transport retains this fetch.
 const {runStockCase}=await import("./stock.ts");
 return {identity,async run(fixture:StockCase,limits:{maxCompletions:number;timeoutMs:number;measureOnly?:boolean;shellHelperDirectory?:string;creativePrompt?:{text:string;sourceDigest:string}}){
  const role=(fixture.roleCase?.role??"chat") as OracleRole;const budget=profile.roles[role];
  const candidate:CandidateProfile={id:profile.model.id,name:profile.model.name,contextWindow:profile.model.contextWindow,maxOutputTokens:budget.maxOutputTokens,maxStageOutputTokens:budget.maxStageOutputTokens,reasoning:profile.model.reasoning,thinkingLevel:budget.thinkingLevel};
  const trace:Trace={counts:[],completions:[],pending:[]};let output=0;
  const stage=["audit","memory","summary"].includes(role);
  const conversationId = `local-stock-${crypto.randomUUID()}`;
  const local=createLocalStreamFn(role,()=>conversationId,()=>stage?budget.maxStageOutputTokens!-output:budget.maxOutputTokens);
  const stream:StreamFn=async(_model,context,options)=>{
   if(limits.measureOnly){
    const payload=await serializeModelRequest(context,role);await countRequestTokens(payload,role,options?.signal);
    throw new Error("Measurement only: no inference requested");
   }
   const result=await local(proxyChatModel(),context,options);
   void result.result().then(message=>{output+=message.usage.output;},()=>{});
   return result;
  };
  const receipt=await traces.run(trace,()=>runStockCase(fixture,candidate,"local",{...limits,spendAvailable:()=>true,stream}));
  await Promise.all(trace.pending);
  const valid=(u:any)=>u&&Number.isSafeInteger(u.prompt_tokens)&&u.prompt_tokens>=0&&Number.isSafeInteger(u.completion_tokens)&&u.completion_tokens>=0;
  const completed=trace.completions.filter(row=>valid(row.usage)&&row.protocolDone&&!row.malformedFrame&&!row.interrupted);
  const parity=trace.completions.length===trace.counts.length&&trace.completions.every((row,i)=>{
   const count=trace.counts[i]; const {role:_role,...countRequest}=count.request;
   countRequest.model=profile.model.id; countRequest.max_tokens=countRequest.max_tokens??countRequest.max_completion_tokens; delete countRequest.max_completion_tokens;
   return valid(row.usage)&&row.usage.prompt_tokens===count.tokens&&isDeepStrictEqual(row.request,countRequest);
  });
  receipt.localRuntime=identity;receipt.tokenMeasurements=trace.counts;receipt.providerReceipts=trace.completions;
  receipt.requests=trace.completions.map(row=>row.request);receipt.rubric=fixture.rubric;
  receipt.metrics={...receipt.metrics,inputTokens:completed.reduce((n,row)=>n+row.usage.prompt_tokens,0),outputTokens:completed.reduce((n,row)=>n+row.usage.completion_tokens,0),costUSD:0,billing:"local, no API charge; hardware cost not estimated"};
  receipt.usageIncomplete=completed.length!==trace.completions.length;
  receipt.checks.push({id:"native_token_count_parity",passed:parity,critical:true,evidence:"Actual /tokenize payload and count match the completion wire payload and native prompt usage, including cached tokens."});
  if(limits.measureOnly){receipt.status="measurement_only";receipt.checks=[];if(trace.counts.length&&trace.counts.every(row=>Number.isSafeInteger(row.tokens)))delete receipt.error;receipt.measurement={role,inputLimit:budget.maxInputTokens,outputReserve:budget.maxOutputTokens,counts:trace.counts.map(row=>row.tokens),fits:fixture.roleCase?.memoryConsent===false?trace.counts.length===0:trace.counts.length>0&&trace.counts.every(row=>Number.isSafeInteger(row.tokens)&&row.tokens<=budget.maxInputTokens),scope:"Initial stock prompt, evidence and full tool schemas; no generation or quality judgment."};}
  else if(trace.completions.some(row=>row.httpStatus>=400||row.error||row.interrupted||!row.protocolDone||row.malformedFrame))receipt.status="transport_error";
  else if(!parity){receipt.status="evaluator_error";receipt.error="Native tokenizer/usage or request identity mismatch";}
  return receipt;
 }};
}
