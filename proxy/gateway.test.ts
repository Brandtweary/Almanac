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
test("completion retains slot until full body consumed and removed routes are absent",async()=>{
 const {app,queue}=createGateway(cfg,mock(),profile);
 const r=await app.request("/v1/chat/completions",{method:"POST",headers:{"X-Request-Id":"request-00000001"},body:JSON.stringify({model:"fixture",messages:[{role:"user",content:"hello"}]})});
 expect(r.status).toBe(200); await r.text(); expect(queue?.status("request-00000001")?.state).toBe("completed");
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
test("truncated stream fails and frees the inference slot",async()=>{
 const base=mock(); const fetcher=(async (url:any, init:any)=>String(url).endsWith("/v1/chat/completions") ? new Response('data: {"choices":[]}\n\n') : base(url,init)) as typeof fetch;
 const {app,queue}=createGateway(cfg,fetcher,profile);
 const r=await app.request("/v1/chat/completions",{method:"POST",headers:{"X-Request-Id":"truncated-0000001"},body:JSON.stringify({model:"fixture",messages:[{role:"user",content:"hi"}],stream:true})});
 await expect(r.text()).rejects.toThrow("incomplete_generation"); expect(queue?.status("truncated-0000001")?.state).toBe("failed");
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
