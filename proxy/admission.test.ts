import {test, expect} from "bun:test";
import {createGateway} from "./server";
import {RateLimiter, ROUTE_LIMITS} from "./rate-limit";
import {config, type ReleaseProfile} from "./config";

const profile: ReleaseProfile = {id:"fixture", qualified:true, receipts:["fixture"], model:{id:"fixture",name:"Fixture",contextWindow:4096,maxTokens:512,reasoning:false,input:["text"],artifactDigest:"a".repeat(64),tokenizerDigest:"b".repeat(64),templateDigest:"c".repeat(64),parser:"llama.cpp",quantization:"fixture"}, roles:Object.fromEntries(["chat","audit","memory","summary","compaction"].map(x=>[x,{maxInputTokens:3000,maxOutputTokens:256,maxStageOutputTokens:1024}])),limits:{queueCapacity:4,queueTimeoutMs:1000,executionTimeoutMs:1000,maxRequestBytes:100000,backgroundMaxTokens:256,speechConcurrency:1,speechTimeoutMs:1000,speechMaxBytes:10000}};
const cfg = {...config, profilePath:"", llmBase:"http://model.invalid", logPath:"/dev/null", ttsBase:"ws://speech.invalid/api/tts_streaming"};
function mock(record?: {url: string, body: any}[]) {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    const path = String(url);
    if (init?.body) record?.push({url: path, body: JSON.parse(String(init.body))});
    if (path.endsWith("/capabilities")) return Response.json({ready: true, qualified: true});
    if (path.endsWith("/info")) return Response.json({model_id: "fixture", model_sha: "0".repeat(40), max_input_length: 512});
    if (path.endsWith("/embed")) return Response.json([[0.5, 0.5]]);
    if (path.endsWith("/apply-template")) return Response.json({prompt: "test"});
    if (path.endsWith("/tokenize")) return Response.json({tokens: [1,2,3], count: 3, max_model_len: 4096});
    return Response.json({choices: [{message: {role: "assistant", content: "fixture"}, finish_reason: "stop"}]});
  }) as typeof fetch;
}
const completion = (extra: object = {}) => ({method: "POST", body: JSON.stringify({model: "fixture", messages: [{role: "user", content: "hi"}], ...extra})});

test("client generation-control fields never reach the backend or the token count", async () => {
  const calls: {url: string, body: any}[] = [];
  const {app} = createGateway(cfg, mock(calls), profile);
  const hostile = {n: 8, ignore_eos: true, min_tokens: 200, prompt_logprobs: 20, logit_bias: {"1": 100},
    chat_template: "{{ bad }}", chat_template_kwargs: {enable_thinking: true}, echo: true, use_beam_search: true};
  const response = await app.request("/v1/chat/completions", completion(hostile));
  expect(response.status).toBe(200);
  expect(calls.length).toBeGreaterThan(0);
  for (const call of calls) for (const field of Object.keys(hostile)) expect(call.body).not.toHaveProperty(field);
});

test("tokenize counts the same pinned render the backend is given", async () => {
  const calls: {url: string, body: any}[] = [];
  const {app} = createGateway(cfg, mock(calls), {...profile, model: {...profile.model, parser: "vllm"}});
  const response = await app.request("/v1/tokenize", {method: "POST",
    body: JSON.stringify({model: "fixture", messages: [{role: "user", content: "hi"}], chat_template: "{{ bad }}", n: 4})});
  expect(await response.json()).toEqual({tokens: 3});
  expect(calls).toHaveLength(1);
  expect(calls[0]!.body.chat_template).toBeUndefined();
  expect(calls[0]!.body).not.toHaveProperty("n");
});

test("the application's own completion fields survive the filter", async () => {
  const calls: {url: string, body: any}[] = [];
  const {app} = createGateway(cfg, mock(calls), profile);
  const response = await app.request("/v1/chat/completions", completion({
    stream_options: {include_usage: true}, store: false, tools: [{type: "function", function: {name: "corpus_search"}}],
    tool_choice: "auto", reasoning_effort: "medium", max_tokens: 64}));
  expect(response.status).toBe(200);
  const sent = calls.find(call => call.url.endsWith("/v1/chat/completions"))!.body;
  expect(sent.stream_options).toEqual({include_usage: true});
  expect(sent.tools).toHaveLength(1);
  expect(sent.tool_choice).toBe("auto");
  expect(sent.reasoning_effort).toBe("medium");
  expect(sent.max_tokens).toBe(64);
});

test("open routes stop admitting a client past its window", async () => {
  const {app} = createGateway(cfg, mock(), profile);
  const corpus = () => app.request("/v1/corpus/search", {method: "POST", body: JSON.stringify({query: "water"})});
  for (let i = 0; i < ROUTE_LIMITS.corpus; i++) expect((await corpus()).status).not.toBe(429);
  const rejected = await corpus();
  expect(rejected.status).toBe(429);
  expect(await rejected.json()).toEqual({error: {code: "rate_limited"}});
  expect(rejected.headers.get("Retry-After")).toBe("60");
  // Windows are per route, and a separate gateway keeps its own counts.
  expect((await app.request("/v1/web-search?q=water")).status).not.toBe(429);
  const other = createGateway(cfg, mock(), profile);
  expect((await other.app.request("/v1/corpus/search", {method: "POST", body: JSON.stringify({query: "water"})})).status).not.toBe(429);
});

test("every open route carries a window", async () => {
  const {app} = createGateway(cfg, mock(), profile);
  const routes: [string, RequestInit][] = [
    ["/v1/corpus/search", {method: "POST", body: "{}"}],
    ["/v1/corpus/read", {method: "POST", body: "{}"}],
    ["/v1/corpus/source/fixture", {}],
    ["/v1/embed", {method: "POST", body: JSON.stringify({inputs: ["x"]})}],
    ["/v1/web-search?q=x", {}],
    ["/v1/tokenize", {method: "POST", body: JSON.stringify({model: "fixture", messages: []})}],
    ["/v1/phonemize", {method: "POST", body: "{}"}],
    ["/v1/chat/completions", completion()],
    ["/voice/lease", {method: "POST"}],
  ];
  for (const [path, init] of routes) {
    let limited = false;
    for (let i = 0; i <= Math.max(...Object.values(ROUTE_LIMITS)); i++) {
      const r = await app.request(path, init);
      if (r.status === 429) { limited = true; break; }
      await r.text();
    }
    expect(limited).toBe(true);
  }
});

test("a sliding window forgets attempts older than its span", async () => {
  const limiter = new RateLimiter(2, 20);
  expect(limiter.limited("client")).toBe(false);
  expect(limiter.limited("client")).toBe(false);
  expect(limiter.limited("client")).toBe(true);
  expect(limiter.limited("other")).toBe(false);
  await new Promise(resolve => setTimeout(resolve, 30));
  expect(limiter.limited("client")).toBe(false);
});
