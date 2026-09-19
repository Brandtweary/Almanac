import {test, expect} from "bun:test";
import {createGateway} from "./server";
import {config} from "./config";
import {mkdtempSync, rmSync, statSync, existsSync, readFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";

function gateway(logMaxBytes: number) {
 const dir = mkdtempSync(join(tmpdir(), "gateway-log-"));
 const logPath = join(dir, "gateway.jsonl");
 const cfg = {...config, profilePath: "", llmBase: "http://model.invalid", logPath, logMaxBytes, subscriberDb: ":memory:"};
 return {dir, logPath, gateway: createGateway(cfg, (async () => Response.json({ready: true, qualified: true})) as unknown as typeof fetch)};
}

function bytes(logPath: string) {
 return ["", ".1"].reduce((total, suffix) => {
  const path = suffix ? logPath.slice(0, -6) + ".1.jsonl" : logPath;
  return total + (existsSync(path) ? statSync(path).size : 0);
 }, 0);
}

test("unauthenticated fault traffic cannot grow the diagnostic log without bound", async () => {
 const {dir, logPath, gateway: g} = gateway(4000);
 try {
  // Distinct mechanisms, so folding cannot account for the volume and only the
  // allotment can hold it; the total attempted is many times the cap.
  for (let index = 0; index < 400; index++) g.log({stage: `probe-${index}`, status: "failed", error: "x".repeat(200)});
  expect(bytes(logPath)).toBeLessThanOrEqual(4000);
  const live = readFileSync(logPath, "utf8").trim().split("\n").map(line => JSON.parse(line));
  expect(live.at(-1).stage).toBe("probe-399");
 } finally { rmSync(dir, {recursive: true, force: true}); }
});

test("one hammered route cannot evict every other failure's evidence", async () => {
 const {dir, logPath, gateway: g} = gateway(4000);
 try {
  g.log({stage: "corpus", status: "failed", error: "the only record of this class"});
  for (let index = 0; index < 5000; index++) g.log({stage: "rate_limit", status: "rejected", route: "completions"});
  const written = readFileSync(logPath, "utf8").trim().split("\n").map(line => JSON.parse(line));
  expect(written.some(row => row.stage === "corpus")).toBe(true);
  const rejections = written.filter(row => row.stage === "rate_limit");
  expect(rejections.length).toBeLessThan(20);
  expect(rejections.map(row => row.occurrence)).toEqual([1, 2, 4, 8, 16, 32, 64, 128, 256, 512, 1024, 2048, 4096]);
 } finally { rmSync(dir, {recursive: true, force: true}); }
});

test("unauthenticated rate-limit rejections fold instead of accumulating", async () => {
 const {dir, logPath, gateway: g} = gateway(200_000);
 try {
  // The signup window is the narrowest, so one visitor reaches rejection in a
  // handful of requests and every one past it writes through the same path a
  // hammering visitor would.
  for (let index = 0; index < 120; index++) {
   const response = await g.app.request("/v1/signup", {method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify({email: `visitor${index}@example.invalid`})});
   await response.text();
  }
  const rejections = readFileSync(logPath, "utf8").trim().split("\n").map(line => JSON.parse(line))
   .filter(row => row.stage === "rate_limit" && row.route === "signup");
  expect(rejections.length).toBeGreaterThan(0);
  expect(rejections.length).toBeLessThan(10);
  expect(rejections.map(row => row.occurrence)).toEqual([1, 2, 4, 8, 16, 32, 64]);
 } finally { rmSync(dir, {recursive: true, force: true}); }
});
