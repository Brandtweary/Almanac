/** Loopback-only hosted transport for developer browser evaluation; never a runtime fallback. */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve, sep, extname } from "node:path";
import { randomUUID } from "node:crypto";
import { CompletionQueue, type Lease } from "../proxy/queue.js";
import type { FixtureLibrary } from "./library.js";

export interface BrowserCandidate {
 model: string; name: string; thinkingLevel?: string; maxInputTokens: number; maxOutputTokens: number; maxStageOutputTokens: number;
 inputUSDPerMillion: number; outputUSDPerMillion: number; maxRequests: number; maxCostUSD: number;
}
export interface BrowserRequestReceipt { id: string; role: string; conversation: string; request: any; response?: any; frames?: any[]; state: string; inputTokens?: number; outputTokens?: number; costUSD?: number; provider?: string; seconds?: number }
export async function startBrowserBridge(options: {dist: string; candidate: BrowserCandidate; apiKey?: string; library: FixtureLibrary; scripted?: boolean; onReceiptEvent?: (event: unknown) => void}) {
 const { candidate } = options;
 if(typeof candidate.model!=="string"||!candidate.model||[candidate.maxInputTokens,candidate.maxOutputTokens,candidate.maxStageOutputTokens,candidate.maxRequests].some(v=>!Number.isSafeInteger(v)||v<=0)||!Number.isFinite(candidate.maxCostUSD)||candidate.maxCostUSD<=0||[candidate.inputUSDPerMillion,candidate.outputUSDPerMillion].some(v=>typeof v!=="number"||!Number.isFinite(v)||v<0))throw new Error("Explicit valid developer model, usage, pricing and spend limits required");
 if (!options.scripted && !options.apiKey) throw new Error("Explicit developer credential required");
 const events: any[] = []; const requests: BrowserRequestReceipt[] = [];
 const queue = new CompletionQueue({queueCapacity: 8, queueTimeoutMs: 60000, executionTimeoutMs: 120000}, event => events.push({at:Date.now(),...event}));
 const roles = Object.fromEntries(["chat","audit","memory","summary","compaction"].map(role => [role,{maxInputTokens:candidate.maxInputTokens,maxOutputTokens:candidate.maxOutputTokens,maxStageOutputTokens:candidate.maxStageOutputTokens,...(candidate.thinkingLevel?{thinkingLevel:candidate.thinkingLevel}:{})}]));
 const profile = {id:`hosted-browser-${candidate.model}`, qualified:false, model:{id:candidate.model,name:candidate.name,contextWindow:candidate.maxInputTokens+candidate.maxOutputTokens,maxTokens:candidate.maxOutputTokens,reasoning:Boolean(candidate.thinkingLevel),input:["text"]},roles,limits:{queueTimeoutMs:60000,executionTimeoutMs:120000}};
 let costUSD=0, reservedUSD=0, unknownBilling=false, fault:"none"|"hold-executing"="none";
 let blocker: Lease|undefined;
 const active = new Set<AbortController>();
 function json(response: ServerResponse, status: number, body: unknown) { response.writeHead(status,{"Content-Type":"application/json"});response.end(JSON.stringify(body)); }
 async function body(request: IncomingMessage) { let raw="";for await (const chunk of request) {raw+=chunk;if(Buffer.byteLength(raw)>1048576)throw new Error("fixture_body_too_large");}return raw?JSON.parse(raw):{}; }
 async function completion(request: IncomingMessage,response:ServerResponse,payload:any) {
  const id=String(request.headers["x-request-id"]??randomUUID());
  const role=String(request.headers["x-request-role"]??"chat"); const conversation=String(request.headers["x-conversation-id"]??id);
  const record:BrowserRequestReceipt={id,role,conversation,request:structuredClone(payload),state:"waiting"};requests.push(record);options.onReceiptEvent?.({type:"request",at:Date.now(),id,role,conversation,payload});
  const abort=new AbortController();active.add(abort);response.on("close",()=>{if(!response.writableEnded)abort.abort();});
  const started=performance.now();let lease:Lease|undefined;let reservation=0;let providerStarted=false;
  try {
   lease=await queue.acquire(id,conversation,role==="chat"||role==="compaction"?"foreground":"background",abort.signal);record.state="executing";
   if(fault==="hold-executing")await new Promise((_resolve,reject)=>lease!.signal.addEventListener("abort",()=>reject(new Error("declared_interruption")),{once:true}));
   if(options.scripted){
    const content="Controlled transport reply. This fixture measures the application, not a candidate model.";
    const raw={id,model:candidate.model,choices:[{index:0,message:{role:"assistant",content},finish_reason:"stop"}],usage:{prompt_tokens:8,completion_tokens:12,total_tokens:20,cost:0}};
    record.response=raw;record.costUSD=0;
    if(payload.stream){response.writeHead(200,{"Content-Type":"text/event-stream"});response.write(`data: ${JSON.stringify({id,model:candidate.model,choices:[{index:0,delta:{role:"assistant",content},finish_reason:null}]})}\n\n`);response.write(`data: ${JSON.stringify({id,model:candidate.model,choices:[{index:0,delta:{},finish_reason:"stop"}],usage:raw.usage})}\n\ndata: [DONE]\n\n`);response.end();}
    else json(response,200,raw);
   } else {
    if(requests.filter(r=>r.state!=="interrupted").length>candidate.maxRequests||unknownBilling)throw new Error("developer_request_or_billing_limit");
    if(Buffer.byteLength(JSON.stringify(payload))+1024>candidate.maxInputTokens)throw new Error("developer_input_exposure_limit");
    const maximum=(candidate.maxInputTokens*candidate.inputUSDPerMillion+candidate.maxOutputTokens*candidate.outputUSDPerMillion)/1e6;
    if(costUSD+reservedUSD+maximum>candidate.maxCostUSD)throw new Error("developer_spend_limit");reservation=maximum;reservedUSD+=reservation;
    const upstreamPayload={...payload,model:candidate.model,max_tokens:Math.min(Number(payload.max_tokens??payload.max_completion_tokens??candidate.maxOutputTokens),candidate.maxOutputTokens),temperature:0,provider:{require_parameters:true,allow_fallbacks:false},...(payload.stream?{stream_options:{include_usage:true}}:{})};
    delete upstreamPayload.reasoning_effort;
    if(candidate.thinkingLevel)upstreamPayload.reasoning={effort:candidate.thinkingLevel};
    providerStarted=true;
    options.onReceiptEvent?.({type:"provider-start",at:Date.now(),id});
    const upstream=await fetch("https://openrouter.ai/api/v1/chat/completions",{method:"POST",headers:{"Content-Type":"application/json",Authorization:`Bearer ${options.apiKey}`},body:JSON.stringify(upstreamPayload),signal:lease.signal});
    if(!upstream.ok){record.response={httpStatus:upstream.status,body:await upstream.text()};throw new Error(`provider_transport_${upstream.status}`);}
    if(!payload.stream){const raw=await upstream.json();record.response=raw;record.provider=raw.provider;record.costUSD=raw.usage?.cost;record.inputTokens=raw.usage?.prompt_tokens;record.outputTokens=raw.usage?.completion_tokens;json(response,200,raw);}
    else {
     response.writeHead(200,{"Content-Type":"text/event-stream","Cache-Control":"no-cache"});record.frames=[];
     let buffer="";const decoder=new TextDecoder();
     for await(const chunk of upstream.body!){response.write(Buffer.from(chunk));buffer+=decoder.decode(chunk,{stream:true});let end:number;
      while((end=buffer.indexOf("\n"))>=0){const line=buffer.slice(0,end).trim();buffer=buffer.slice(end+1);if(!line.startsWith("data:")||line==="data: [DONE]")continue;const frame=JSON.parse(line.slice(5));record.frames.push(frame);options.onReceiptEvent?.({type:"provider-frame",at:Date.now(),id,frame});if(frame.provider)record.provider=frame.provider;if(frame.usage){record.costUSD=frame.usage.cost;record.inputTokens=frame.usage.prompt_tokens;record.outputTokens=frame.usage.completion_tokens;}}
     }
     response.end();
    }
    if(typeof record.costUSD==="number"&&Number.isFinite(record.costUSD))costUSD+=record.costUSD;else unknownBilling=true;
   }
   record.state="completed";lease.finish();
  }catch(error){record.state=abort.signal.aborted||lease?.signal.aborted||queue.status(id)?.state==="interrupted"?"interrupted":"failed";record.response??={error:error instanceof Error?error.message:String(error)};lease?.finish("failed");if(!response.headersSent)json(response,503,{error:record.response});else response.end();}
  finally{options.onReceiptEvent?.({type:"request-final",at:Date.now(),record});if(providerStarted&&record.costUSD===undefined&&!record.response?.httpStatus)unknownBilling=true;reservedUSD-=reservation;record.seconds=(performance.now()-started)/1000;active.delete(abort);}
 }
 const dist=resolve(options.dist);
 const server=createServer((request,response)=>{void(async()=>{
  const url=new URL(request.url??"/","http://localhost");const path=url.pathname;
  if(path==="/v1/profile")return json(response,200,{ready:false,qualificationMode:true,status:"developer_hosted_integration",profile,capabilities:{tokenizer:"conservative-byte-bound; not native-tokenizer qualification"},corpus:{ready:true,qualified:false}});
  if(path==="/v1/tokenize"){const payload=await body(request);return json(response,200,{tokens:Buffer.byteLength(JSON.stringify(payload))+1024,diagnostic:true});}
  if(path.startsWith("/v1/requests/")){const id=decodeURIComponent(path.slice(13));return json(response,request.method==="DELETE"?200:queue.status(id)?200:404,request.method==="DELETE"?{cancelled:queue.cancel(id)}:queue.status(id));}
  if(path==="/v1/chat/completions")return completion(request,response,await body(request));
  if(path==="/v1/corpus/search"||path==="/v1/corpus/read")return json(response,200,options.library.handle(path.endsWith("search")?"search":"read",await body(request)));
  if(path==="/v1/embed")return json(response,503,{error:"Embedding not included in controlled browser fixture"});
  if(path==="/v1/web-search")return json(response,200,{results:[],degraded:true});
  if(path.startsWith("/v1/corpus/source/")){const handle=decodeURIComponent(path.slice("/v1/corpus/source/".length));const passage=options.library.passages.find(p=>p.passage_id===handle);if(!passage)return json(response,410,{error:"unavailable_fixture_source"});response.writeHead(200,{"Content-Type":"text/plain","X-Fixture-Source-Version":passage.source_revision});return response.end(`${passage.title}\nSource version: ${passage.source_revision}\nPassage: ${passage.passage_id}\n\n${passage.excerpt}`);}
  const file=resolve(dist,`.${decodeURIComponent(path)}`);if(!file.startsWith(dist+sep)&&file!==dist)return json(response,403,{error:"invalid_path"});
  const target=path==="/"?resolve(dist,"index.html"):file;
  try {const bytes=await readFile(target);response.writeHead(200,{"Content-Type":({".html":"text/html",".js":"text/javascript",".css":"text/css",".json":"application/json",".woff2":"font/woff2",".woff":"font/woff"} as Record<string,string>)[extname(target)]??"application/octet-stream"});response.end(bytes);}catch{json(response,404,{error:"not_found"});}
 })().catch(error=>{if(!response.headersSent)json(response,500,{error:error instanceof Error?error.message:String(error)});else response.end();});});
 await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));const address=server.address();if(!address||typeof address==="string")throw new Error("Invalid listener");
 return {url:`http://127.0.0.1:${address.port}`,requests,events,profile,
  get costUSD(){return costUSD;},get unknownBilling(){return unknownBilling;},
  async setFault(next:"none"|"hold-waiting"|"hold-executing") {blocker?.finish();blocker=undefined;fault=next==="hold-executing"?next:"none";if(next==="hold-waiting")blocker=await queue.acquire(randomUUID(),"fixture-blocker","foreground",new AbortController().signal);},
  async close(){blocker?.finish();for(const controller of active)controller.abort();await new Promise<void>(resolve=>server.close(()=>resolve()));},
 };
}
