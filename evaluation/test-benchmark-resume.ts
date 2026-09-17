import assert from "node:assert/strict";
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {spawnSync} from "node:child_process";
import {loadStockCases} from "./stock-cases.ts";
import {CampaignBudget} from "./campaign-budget.ts";
const dir=mkdtempSync(join(tmpdir(),"benchmark-resume-"));
try{
 const profile={...JSON.parse(readFileSync(new URL("./candidates.json",import.meta.url),"utf8"))[0],providerRouting:{only:["fixture"]},prices:{input:1,output:2,cacheRead:3,cacheWrite:4}};
 const fixture=loadStockCases().find(c=>c.split==="development"&&c.track==="agent")!;
 const profiles=join(dir,"profiles.json"),priorFile=join(dir,"prior.json"),output=join(dir,"run");const prior={ceilingUSD:.001,priorReportedUSD:0,priorUnknownReserveUSD:0};
 writeFileSync(profiles,JSON.stringify([profile]));writeFileSync(priorFile,JSON.stringify(prior));
 const exe=fileURLToPath(new URL("../node_modules/.bin/tsx",import.meta.url));const args=[fileURLToPath(new URL("./benchmark-run.ts",import.meta.url)),"--profiles",profiles,"--prior-budget",priorFile,"--output",output,"--max-spend",".001","--case",fixture.id];
 const options={encoding:"utf8" as const,env:{...process.env,OPENROUTER_API_KEY:"synthetic-not-a-credential"},timeout:30000};
 const initial=spawnSync(exe,args,options);assert.equal(initial.status,0,initial.stderr);
 assert.equal(JSON.parse(readFileSync(join(output,"report.json"),"utf8")).cases[0].status,"budget_not_run");
 const ledger=join(output,"budget-ledger.json");const budget=new CampaignBudget(ledger,prior);budget.reserve(profile.id.replaceAll("/","__")+"--"+fixture.id+".json",.0005);
 const resumed=spawnSync(exe,[...args,"--resume"],options);assert.equal(resumed.status,0,resumed.stderr);
 const report=JSON.parse(readFileSync(join(output,"report.json"),"utf8"));assert.equal(report.cases[0].status,"interrupted_unmeasured");assert.equal(report.conservativeUnreportedUSD,.0005);
 rmSync(ledger);const missing=spawnSync(exe,[...args,"--resume"],options);assert.notEqual(missing.status,0);assert.match(missing.stderr,/existing budget ledger/);
 console.log("Legacy benchmark retains interrupted reservations, forbids replay and refuses missing ledgers without inference.");
}finally{rmSync(dir,{recursive:true,force:true});}
