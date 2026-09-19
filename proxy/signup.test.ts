import {test, expect} from "bun:test";
import {Database} from "bun:sqlite";
import {mkdtempSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {createGateway} from "./server";
import {config, type ReleaseProfile} from "./config";
import {ROUTE_LIMITS} from "./rate-limit";

const profile: ReleaseProfile = {id:"fixture", qualified:true, receipts:["fixture"], model:{id:"fixture",name:"Fixture",contextWindow:4096,maxTokens:512,reasoning:false,input:["text"],artifactDigest:"a".repeat(64),tokenizerDigest:"b".repeat(64),templateDigest:"c".repeat(64),parser:"llama.cpp",quantization:"fixture"}, roles:Object.fromEntries(["chat","audit","memory","summary","compaction"].map(x=>[x,{maxInputTokens:3000,maxOutputTokens:256,maxStageOutputTokens:1024}])),limits:{queueCapacity:4,queueTimeoutMs:1000,executionTimeoutMs:1000,maxRequestBytes:10000,backgroundMaxTokens:256,speechConcurrency:1,speechTimeoutMs:1000,speechMaxBytes:10000}};

function gateway() {
 const path = join(mkdtempSync(join(tmpdir(), "almanac-signup-")), "subscribers.db");
 const cfg = {...config, profilePath:"", llmBase:"http://model.invalid", logPath:"/dev/null", subscriberDb:path};
 const {app} = createGateway(cfg, (async () => Response.json({ready:true, qualified:true})) as unknown as typeof fetch, profile);
 return {app, rows: () => new Database(path, {readonly:true})
  .query<{email:string; created_at:string}, []>("SELECT email, created_at FROM subscribers ORDER BY created_at").all()};
}

function submit(app: ReturnType<typeof gateway>["app"], email: unknown) {
 return app.request("/v1/signup", {method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({email})});
}

test("an address is stored under the schema its collector reads", async () => {
 const {app, rows} = gateway();
 expect((await submit(app, "  Reader@Example.Invalid ")).status).toBe(200);
 const stored = rows();
 expect(stored.map(r => r.email)).toEqual(["reader@example.invalid"]);
 expect(Number.isFinite(Date.parse(stored[0]!.created_at))).toBe(true);
});

test("a resubmitted address is not a second row and reads no differently", async () => {
 const {app, rows} = gateway();
 const first = await submit(app, "reader@example.invalid");
 const again = await submit(app, "reader@example.invalid");
 expect(again.status).toBe(first.status);
 expect(await again.json()).toEqual(await first.json());
 expect(rows().length).toBe(1);
});

test("malformed submissions are rejected and stored nowhere", async () => {
 // A fresh gateway per case: the window would otherwise answer the later ones
 // before the shape check does, and prove nothing about the shape check.
 for (const value of ["", "  ", "not-an-address", "two@@example.invalid", "spaced address@example.invalid",
                      "a".repeat(250) + "@example.invalid", 42, null, {}]) {
  const {app, rows} = gateway();
  expect((await submit(app, value)).status).toBe(400);
  expect(rows()).toEqual([]);
 }
 const {app} = gateway();
 expect((await app.request("/v1/signup", {method:"POST", body:"{"})).status).toBe(400);
});

test("the public write endpoint carries a window like every other route", async () => {
 const {app, rows} = gateway();
 let last = new Response();
 for (let i = 0; i <= ROUTE_LIMITS.signup; i++) last = await submit(app, `reader${i}@example.invalid`);
 expect(last.status).toBe(429);
 expect(last.headers.get("Retry-After")).toBeTruthy();
 expect(rows().length).toBe(ROUTE_LIMITS.signup);
});
