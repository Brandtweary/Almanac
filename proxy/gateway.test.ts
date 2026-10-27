import {test, expect} from "bun:test";
import {createGateway} from "./server";
import {config, type ReleaseProfile} from "./config";
const profile: ReleaseProfile = {id:"fixture", qualified:true, receipts:["fixture"], model:{id:"fixture",name:"Fixture",contextWindow:4096,maxTokens:512,reasoning:false,input:["text"],artifactDigest:"a".repeat(64),tokenizerDigest:"b".repeat(64),templateDigest:"c".repeat(64),parser:"llama.cpp",quantization:"fixture"}, roles:Object.fromEntries(["chat","audit","memory","summary","compaction"].map(x=>[x,{maxInputTokens:3000,maxOutputTokens:256,maxStageOutputTokens:1024}])),limits:{queueCapacity:4,queueTimeoutMs:1000,executionTimeoutMs:1000,maxRequestBytes:10000,backgroundMaxTokens:256,speechConcurrency:1,speechTimeoutMs:1000,speechMaxBytes:10000}};
const cfg = {...config, profilePath:"", llmBase:"http://model.invalid",logPath:"/dev/null", subscriberDb:":memory:"};
function mock(ready=true) { return (async (url: string | URL | Request) => {
 const path=String(url); if(path.endsWith("/capabilities")) return Response.json({ready, qualified:true});
 if(path.endsWith("/health")) return Response.json({status:"ok"});
 if(path.endsWith("/apply-template")) return Response.json({prompt:"test"});
 if(path.endsWith("/tokenize")) return Response.json({tokens:[1,2,3]});
 return Response.json({choices:[{message:{role:"assistant",content:"fixture"},finish_reason:"stop"}]});
 }) as typeof fetch; }
test("missing profile and mandatory corpus fail closed", async()=>{
 const empty=createGateway(cfg,mock()); expect((await empty.app.request("/ready")).status).toBe(503);
 const missing=createGateway(cfg,mock(false),profile);
 expect((await missing.app.request("/v1/chat/completions",{method:"POST",body:JSON.stringify({model:"fixture",messages:[{role:"user",content:"hi"}]})})).status).toBe(503);
});
test("completion request status remains available after response consumption and removed routes are absent",async()=>{
 const {app}=createGateway(cfg,mock(),profile);
 const r=await app.request("/v1/chat/completions",{method:"POST",headers:{"X-Request-Id":"request-00000001"},body:JSON.stringify({model:"fixture",messages:[{role:"user",content:"hello"}]})});
 expect(r.status).toBe(200); await r.text(); expect((await (await app.request("/v1/requests/request-00000001")).json()).state).toBe("completed");
 expect((await app.request("/anon-init",{method:"POST"})).status).toBe(404);
 expect((await app.request("/redeem",{method:"POST"})).status).toBe(404);
});
test("role output budgets reject invalid requests without backend completion",async()=>{
 const {app}=createGateway(cfg,mock(),profile);
 const r=await app.request("/v1/chat/completions",{method:"POST",body:JSON.stringify({model:"fixture",messages:[{}],max_tokens:1000})}); expect(r.status).toBe(400);
});
test("candidate mode remains visibly unready and refuses external binding", async()=>{
 const candidate = {...profile, qualified:false, receipts:[]};
 expect(()=>createGateway({...cfg,host:"0.0.0.0",qualificationMode:true},mock(),candidate)).toThrow("loopback");
 const {app}=createGateway({...cfg,host:"127.0.0.1",qualificationMode:true},mock(),candidate);
 expect((await app.request("/ready")).status).toBe(503);
 const state=await (await app.request("/v1/profile")).json(); expect(state.qualificationMode).toBe(true); expect(state.status).toBe("qualification_only");
});
test("truncated stream fails explicitly",async()=>{
 const base=mock(); const fetcher=(async (url:any, init:any)=>String(url).endsWith("/v1/chat/completions") ? new Response('data: {"choices":[]}\n\n') : base(url,init)) as typeof fetch;
 const {app}=createGateway(cfg,fetcher,profile);
 const r=await app.request("/v1/chat/completions",{method:"POST",headers:{"X-Request-Id":"truncated-0000001"},body:JSON.stringify({model:"fixture",messages:[{role:"user",content:"hi"}],stream:true})});
 await expect(r.text()).rejects.toThrow("incomplete_generation"); expect((await (await app.request("/v1/requests/truncated-0000001")).json()).state).toBe("failed");
});
test("generation uses the almanac tier and invisibly retries preemption before its first token",async()=>{
 const base=mock(); let tries=0; const priorities:string[]=[];
 const fetcher=(async(url:any,init:any)=>{
  if(String(url).endsWith("/v1/chat/completions")) {
   priorities.push(new Headers(init.headers).get("X-Request-Priority") ?? "");
   tries++;
   if(tries===1) return new Response('data: {"error":{"code":"preempted","message":"preempted"}}\n\n',{headers:{"Content-Type":"text/event-stream"}});
   return new Response('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n',{headers:{"Content-Type":"text/event-stream"}});
  }
  return base(url,init);
 }) as typeof fetch;
 const {app}=createGateway(cfg,fetcher,profile);
 const r=await app.request("/v1/chat/completions",{method:"POST",headers:{"X-Request-Id":"retry-request-0001"},body:JSON.stringify({model:"fixture",messages:[{role:"user",content:"hello"}],stream:true})});
 expect(r.status).toBe(200); expect(await r.text()).toContain("[DONE]"); expect(tries).toBe(2); expect(priorities).toEqual(["almanac","almanac"]);
 expect((await (await app.request("/v1/requests/retry-request-0001")).json()).state).toBe("completed");
});
test("pre-first-token retry exhaustion remains an explicit retryable stream error",async()=>{
 const base=mock(); let tries=0;
 const fetcher=(async(url:any)=>{
  if(String(url).endsWith("/v1/chat/completions")) {
   tries++;
   return Response.json({error:{code:"preempted"}},{status:503});
  }
  return base(url);
 }) as typeof fetch;
 const {app}=createGateway(cfg,fetcher,profile);
 const response=await app.request("/v1/chat/completions",{method:"POST",headers:{"X-Request-Id":"exhausted-request-0001"},body:JSON.stringify({model:"fixture",messages:[{role:"user",content:"hello"}],stream:true})});
 expect(response.status).toBe(200); expect(await response.text()).toContain('"finish_reason":"preempted"'); expect(tries).toBe(4);
 expect((await (await app.request("/v1/requests/exhausted-request-0001")).json()).state).toBe("preempted");
});
test("a successful SSE response streams its first token before generation finishes",async()=>{
 const base=mock(); let finish!:()=>void;
 const fetcher=(async(url:any)=>{
  if(String(url).endsWith("/v1/chat/completions")) return new Response(new ReadableStream<Uint8Array>({start(controller){
   controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"first token"}}]}\n\n'));
   finish=()=>{controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));controller.close();};
  }}),{headers:{"Content-Type":"text/event-stream"}});
  return base(url);
 }) as typeof fetch;
 const {app}=createGateway(cfg,fetcher,profile);
 const response=await app.request("/v1/chat/completions",{method:"POST",body:JSON.stringify({model:"fixture",messages:[{role:"user",content:"hello"}],stream:true})});
 const reader=response.body!.getReader();
 const first=await reader.read(); expect(new TextDecoder().decode(first.value)).toContain("first token");
 finish(); const rest=await reader.read(); expect(new TextDecoder().decode(rest.value)).toContain("[DONE]");
 expect((await reader.read()).done).toBe(true);
});
test("a mid-stream preemption reports that the partial answer must be regenerated",async()=>{
 const base=mock(); let preempt!:()=>void; let generations=0;
 const fetcher=(async(url:any)=>{
  if(String(url).endsWith("/v1/chat/completions")) {
   generations++;
   return new Response(new ReadableStream<Uint8Array>({start(controller){
    controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n'));
    preempt=()=>{controller.enqueue(new TextEncoder().encode('data: {"error":{"code":"preempted","message":"preempted"}}\n\n'));controller.close();};
   }}),{headers:{"Content-Type":"text/event-stream"}});
  }
  return base(url);
 }) as typeof fetch;
 const {app}=createGateway(cfg,fetcher,profile);
 const response=await app.request("/v1/chat/completions",{method:"POST",headers:{"X-Request-Id":"midstream-request-0001"},body:JSON.stringify({model:"fixture",messages:[{role:"user",content:"hello"}],stream:true})});
 const reader=response.body!.getReader();
 expect(new TextDecoder().decode((await reader.read()).value)).toContain("partial");
 preempt(); const remainder=await reader.read();
 expect(new TextDecoder().decode(remainder.value)).toContain('"finish_reason":"preempted_midstream"');
 expect((await reader.read()).done).toBe(true); expect(generations).toBe(1);
 expect((await (await app.request("/v1/requests/midstream-request-0001")).json()).state).toBe("preempted_midstream");
});
test("queue timeout remains an explicit retryable response",async()=>{
 const base=mock();
 const fetcher=(async(url:any)=>String(url).endsWith("/v1/chat/completions") ? Response.json({error:{code:"queue_timeout"}},{status:504}) : base(url)) as typeof fetch;
 const {app}=createGateway(cfg,fetcher,profile);
 const r=await app.request("/v1/chat/completions",{method:"POST",headers:{"X-Request-Id":"timeout-request-0001"},body:JSON.stringify({model:"fixture",messages:[{role:"user",content:"hello"}]})});
 expect(r.status).toBe(504); expect((await r.json()).error.code).toBe("queue_timeout");
 expect((await (await app.request("/v1/requests/timeout-request-0001")).json()).state).toBe("queue_timeout");
});
test("request status reflects the bm-queue waiting position",async()=>{
 const base=mock(); let release!:()=>void; let entered!:()=>void;
 const enteredQueue=new Promise<void>(resolve=>entered=resolve);
 const fetcher=(async(url:any,init:any)=>{
  if(String(url).endsWith("/health")) return Response.json({queue:{active_request_id:"foreground-00000001",waiting_requests:[{id:"waiting-request-0001",priority:"almanac"}]}});
  if(String(url).endsWith("/v1/chat/completions")) { entered(); return new Promise<Response>(resolve=>release=()=>resolve(Response.json({choices:[{message:{role:"assistant",content:"ok"},finish_reason:"stop"}]}))); }
  return base(url,init);
 }) as typeof fetch;
 const {app}=createGateway(cfg,fetcher,profile);
 const result=app.request("/v1/chat/completions",{method:"POST",headers:{"X-Request-Id":"waiting-request-0001"},body:JSON.stringify({model:"fixture",messages:[{role:"user",content:"hello"}]})});
 await enteredQueue;
 const state=await(await app.request("/v1/requests/waiting-request-0001")).json();
 expect(state).toMatchObject({state:"waiting",position:1});
 release(); expect((await result).status).toBe(200);
});
test("isolated container qualification requires an exact deployment declaration",async()=>{
 const candidate = {...profile,qualified:false,receipts:[]};
 for (const qualificationBoundary of ["", "container", "isolated", "isolated-container "]) {
  expect(()=>createGateway({...cfg,host:"0.0.0.0",qualificationMode:true,qualificationBoundary},mock(),candidate)).toThrow();
 }
 const {app}=createGateway({...cfg,host:"0.0.0.0",qualificationMode:true,qualificationBoundary:"isolated-container"},mock(),candidate);
 expect((await app.request("/ready")).status).toBe(503);
 expect((await (await app.request("/v1/profile")).json()).qualificationMode).toBe(true);
});
test("vLLM route uses full-chat endpoint and validates token accounting",async()=>{
 const calls:{url:string,body:any}[]=[];
 const fetcher=(async(url:any,init:any)=>{calls.push({url:String(url),body:JSON.parse(init.body)});return Response.json({tokens:[1,2,3],count:3,max_model_len:4096});}) as typeof fetch;
 const {app}=createGateway(cfg,fetcher,{...profile,model:{...profile.model,parser:"vllm"}});
 const payload={model:"fixture",messages:[{role:"user",content:"question"}],tools:[{type:"function",function:{name:"corpus_search",parameters:{type:"object"}}}],reasoning_effort:"high"};
 const r=await app.request("/v1/tokenize",{method:"POST",body:JSON.stringify(payload)});
 expect(await r.json()).toEqual({tokens:3});expect(calls).toHaveLength(1);expect(calls[0]!.url).toEndWith("/tokenize");expect(calls[0]!.body.messages).toEqual(payload.messages);expect(calls[0]!.body.tools).toEqual(payload.tools);
 const broken=createGateway(cfg,(async()=>Response.json({tokens:[1],count:3,max_model_len:4096})) as unknown as typeof fetch,{...profile,model:{...profile.model,parser:"vllm"}});
 expect((await broken.app.request("/v1/tokenize",{method:"POST",body:JSON.stringify(payload)})).status).toBe(502);
});
test("phonemization preserves Unicode, upstream errors and client cancellation",async()=>{
 const abort=new AbortController();let forwarded:AbortSignal|undefined;let received="";
 const {app}=createGateway(cfg,(async(_url:any,init:any)=>{forwarded=init.signal;received=init.body;return Response.json({error:{code:"phonemizer_busy"}},{status:503});}) as typeof fetch,profile);
 const payload={texts:["café","日本語"],language:"en-us"};
 const r=await app.request(new Request("http://localhost/v1/phonemize",{method:"POST",body:JSON.stringify(payload),signal:abort.signal}));
 expect(r.status).toBe(503);expect(JSON.parse(received)).toEqual(payload);abort.abort();expect(forwarded?.aborted).toBe(true);
 expect((await app.request("/v1/phonemize",{method:"POST",body:"x".repeat(131073)})).status).toBe(413);
});
test("memory stage output budgets are mandatory profile data",async()=>{
 const roles=structuredClone(profile.roles);delete roles.memory!.maxStageOutputTokens;
 const {app}=createGateway(cfg,mock(),{...profile,roles});
 const state=await(await app.request("/v1/profile")).json();expect(state.status).toBe("release_profile_invalid");expect(state.profile).toBeNull();
});
test("a profile serves no notice by default; a set notice must be one bounded line",async()=>{
 const state=await(await(await createGateway(cfg,mock(),profile).app.request("/v1/profile")).json());
 expect(state.status).toBe("ready"); expect(state.profile.notice).toBeUndefined();
 for (const bad of [7 as unknown as string,"   ","x".repeat(241)]) {
  const invalid=createGateway(cfg,mock(),{...profile,notice:bad});
  expect((await(await invalid.app.request("/v1/profile")).json()).status).toBe("release_profile_invalid");
 }
 const good=createGateway(cfg,mock(),{...profile,notice:"Scheduled corpus maintenance tonight."});
 const carrying=await(await good.app.request("/v1/profile")).json();
 expect(carrying.status).toBe("ready"); expect(carrying.profile.notice).toBe("Scheduled corpus maintenance tonight.");
});
test("untrusted source downloads retain a sandbox policy through gateway middleware", async()=>{
 const fetcher = (async()=>new Response('<script>window.injected=true</script>',{headers:{'Content-Type':'text/html'}})) as unknown as typeof fetch;
 const {app}=createGateway(cfg,fetcher,profile);
 const response=await app.request('/v1/corpus/source/fixture');
 expect(await response.text()).toContain('<script>');
 expect(response.headers.get('Content-Disposition')).toBe('attachment');
 const policy=response.headers.get('Content-Security-Policy')??'';
 expect(policy).toContain("sandbox; default-src 'none'");
 expect(policy).toContain("frame-ancestors 'none'");
 expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
});

test("a readable source keeps the content service's own disposition and name", async()=>{
 const named="inline; filename=\"Understanding Composting.txt\"; filename*=UTF-8''Understanding%20Composting.txt";
 const fetcher = (async()=>new Response('article text',{headers:{'Content-Type':'text/plain; charset=utf-8','Content-Disposition':named}})) as unknown as typeof fetch;
 const {app}=createGateway(cfg,fetcher,profile);
 const response=await app.request('/v1/corpus/source/fixture');
 // Forcing a download here is what leaves the browser naming the file after the handle.
 expect(response.headers.get('Content-Disposition')).toBe(named);
 expect(response.headers.get('Content-Type')).toBe('text/plain; charset=utf-8');
 expect((response.headers.get('Content-Security-Policy')??'')).toContain("sandbox; default-src 'none'");
});

test("pinned model sampling applies before counting and generation",async()=>{
 const bodies:any[]=[];const base=mock();
 const fetcher=(async(url:any,init:any)=>{if(String(url).endsWith("/apply-template")||String(url).endsWith("/v1/chat/completions"))bodies.push(JSON.parse(init.body));return base(url,init);}) as typeof fetch;
 const {app}=createGateway(cfg,fetcher,{...profile,model:{...profile.model,sampling:{temperature:1,top_p:.95,top_k:64}}});
 const result=await app.request("/v1/chat/completions",{method:"POST",body:JSON.stringify({model:"fixture",messages:[{role:"user",content:"Synthetic"}],temperature:0,top_p:1,top_k:-1})});
 expect(result.status).toBe(200);expect(bodies).toHaveLength(2);expect(bodies[0]).toEqual(bodies[1]);expect(bodies[0]).toMatchObject({temperature:1,top_p:.95,top_k:64});
 const bad=createGateway(cfg,mock(),{...profile,model:{...profile.model,sampling:{temperature:1,top_p:.95,top_k:0}}});expect(bad.profile).toBeNull();
});

test("the library listing is forwarded, and its failures read like the other corpus routes",async()=>{
 const calls:string[]=[];
 const fetcher=(async(url:any,init:any)=>{const path=String(url);calls.push(path);
  if(path.endsWith("/v1/corpus/collections")){expect(init.method).toBeUndefined();return Response.json({generation:"a".repeat(64),collections:[{category:"Scripture and canon",title:"Fixture archive"}]});}
  return mock()(url,init);}) as unknown as typeof fetch;
 const {app}=createGateway(cfg,fetcher,profile);
 const listed=await app.request("/v1/corpus/collections");
 expect(listed.status).toBe(200);
 expect((await listed.json()).collections[0].category).toBe("Scripture and canon");
 expect(calls).toContain("http://127.0.0.1:8791/v1/corpus/collections");
 const down=(async()=>{throw new TypeError("connection refused");}) as unknown as typeof fetch;
 const absent=await createGateway(cfg,down,profile).app.request("/v1/corpus/collections");
 expect(absent.status).toBe(502);
 expect(await absent.json()).toEqual({error:{code:"corpus_unavailable"}});
});

test("a corpus that is slow is reported as slow, and an absent one as absent",async()=>{
 const slow=(async(_url:any,init:any)=>new Promise<Response>((_resolve,reject)=>{
  init.signal.addEventListener("abort",()=>reject(init.signal.reason));
 })) as unknown as typeof fetch;
 const {app}=createGateway({...cfg,corpusTimeoutMs:1000},slow,profile);
 const late=await app.request("/v1/corpus/search",{method:"POST",body:JSON.stringify({query:"compost"})});
 expect(late.status).toBe(504);
 expect(await late.json()).toEqual({error:{code:"corpus_timeout"}});
 const down=(async()=>{throw new TypeError("connection refused");}) as unknown as typeof fetch;
 const absent=await createGateway(cfg,down,profile).app.request("/v1/corpus/search",{method:"POST",body:JSON.stringify({query:"compost"})});
 expect(absent.status).toBe(502);
 expect(await absent.json()).toEqual({error:{code:"corpus_unavailable"}});
});

test("health publishes a state and a progress stamp that only served work moves",async()=>{
 const {app}=createGateway(cfg,mock(),profile);
 const idle=await(await app.request("/health")).json();
 expect(idle.state).toBe("idle");expect(idle.inflight).toBe(0);expect(typeof idle.last_progress_ts).toBe("number");
 await Bun.sleep(5);
 // Polling is not progress: a stamp the reader refreshes reports the reader.
 expect((await(await app.request("/health")).json()).last_progress_ts).toBe(idle.last_progress_ts);
 const served=await app.request("/v1/chat/completions",{method:"POST",headers:{"X-Request-Id":"progress-00000001"},body:JSON.stringify({model:"fixture",messages:[{role:"user",content:"hi"}]})});
 expect(served.status).toBe(200);await served.text();
 expect((await(await app.request("/health")).json()).last_progress_ts).toBeGreaterThan(idle.last_progress_ts);
});

test("a request arriving after idleness is not reported as stalled since the last answer",async()=>{
 const base=mock();let release=()=>{};
 const held=new Promise<void>(resolve=>{release=resolve;});
 const fetcher=(async(url:any,init:any)=>{
  if(String(url).endsWith("/v1/corpus/search")){await held;return Response.json({results:[]});}
  return base(url,init);}) as typeof fetch;
 const {app}=createGateway(cfg,fetcher,profile);
 const idle=await(await app.request("/health")).json();
 await Bun.sleep(50);
 const started=Date.now()/1000;
 const pending=app.request("/v1/corpus/search",{method:"POST",body:JSON.stringify({query:"compost"})});
 await Bun.sleep(5);
 const busy=await(await app.request("/health")).json();
 expect(busy.state).toBe("serving");
 // The clock a supervisor reads starts with the busy period, not the idle one.
 expect(busy.last_progress_ts).toBeGreaterThanOrEqual(started-0.001);
 expect(busy.last_progress_ts).toBeGreaterThan(idle.last_progress_ts+0.04);
 // A request that keeps waiting does not move it: that is a real stall.
 await Bun.sleep(20);
 expect((await(await app.request("/health")).json()).last_progress_ts).toBe(busy.last_progress_ts);
 release();expect((await pending).status).toBe(200);
});

test("health fails while the model behind the gateway cannot answer",async()=>{
 const base=mock();let probes=0;
 const fetcher=(async(url:any,init:any)=>{
  if(String(url)===`${cfg.llmBase}/health`){probes++;return new Response("unavailable",{status:503});}
  return base(url,init);}) as typeof fetch;
 const {app}=createGateway(cfg,fetcher,profile);
 const r=await app.request("/health");
 expect(r.status).toBe(503);
 expect(await r.json()).toMatchObject({ok:false,state:"model_unavailable"});
 // Unauthenticated and unmetered, so repeated polling must not become load.
 for(let i=0;i<5;i++) expect((await app.request("/health")).status).toBe(503);
 expect(probes).toBe(1);
});
