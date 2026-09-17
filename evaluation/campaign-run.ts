/** Full developer campaign with immutable cases, provider pins and durable spend reservations. */
import {parseArgs} from "node:util";
import {readFileSync,writeFileSync,mkdirSync,existsSync,readdirSync,statSync} from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {createHash} from "node:crypto";
import {loadStockCases,objectDigest} from "./stock-cases.ts";
import {loadCreativeSuite} from "./creative.ts";
import {loadBackgroundSanityCases} from "./background-sanity.ts";
import {runStockCase,type CandidateProfile} from "./stock.ts";
import {CampaignBudget,CampaignReservations,claimCampaign} from "./campaign-budget.ts";
const {values}=parseArgs({options:{profiles:{type:"string"},"prior-budget":{type:"string"},output:{type:"string"},prepare:{type:"boolean"},resume:{type:"boolean"}}});
if(!values.profiles||!values["prior-budget"]||!values.output)throw new Error("Explicit profiles, cumulative prior budget and output required");
const profiles:CandidateProfile[]=JSON.parse(readFileSync(values.profiles,"utf8"));
if(profiles.length!==10||new Set(profiles.map(p=>p.id)).size!==10)throw new Error("Full campaign requires ten distinct pinned candidates");
for(const p of profiles){if(!p.prices||Object.values(p.prices).some(n=>!Number.isFinite(n)||n<0)||p.providerRouting?.only?.length!==1||!Number.isSafeInteger(p.maxOutputTokens)||p.maxOutputTokens<1||!Number.isSafeInteger(p.maxStageOutputTokens)||p.maxStageOutputTokens!<1||p.contextWindow<65536+p.maxOutputTokens)throw new Error("Invalid candidate identity, provider pin, prices or exposure limits");}
const prior=JSON.parse(readFileSync(values["prior-budget"],"utf8"));
const stock=loadStockCases(),creative=loadCreativeSuite(),background=loadBackgroundSanityCases();
const groups=[creative.cases.slice(),stock.filter(c=>c.family==="research"),background.slice(),stock.filter(c=>c.family!=="research"&&c.track!=="shell"),stock.filter(c=>c.track==="shell")];
const cases:typeof stock=[];while(groups.some(g=>g.length))for(const group of groups){const c=group.shift();if(c)cases.push(c);}
if(stock.length!==49||creative.cases.length!==5||background.length!==3||new Set(cases.map(c=>c.id)).size!==57)throw new Error("Unexpected frozen campaign case shape");
const root=fileURLToPath(new URL("../",import.meta.url));const output=path.resolve(values.output);
if(existsSync(output)&&!values.resume)throw new Error("Fresh output required unless exact-identity resume is explicit");if(!existsSync(output)){mkdirSync(path.dirname(output),{recursive:true});mkdirSync(output);}
const releaseOwnership=claimCampaign(output);
const hashes:Record<string,string>={};
function snapshot(dir:string){for(const entry of readdirSync(path.join(root,dir))){const relative=path.join(dir,entry),full=path.join(root,relative);if(statSync(full).isDirectory()){if(entry!=="__pycache__")snapshot(relative);}else if(/\.(ts|json|py|md)$/.test(entry)){const bytes=readFileSync(full);hashes[relative]=createHash("sha256").update(bytes).digest("hex");if(!values.resume){const dest=path.join(output,"snapshot",relative);mkdirSync(path.dirname(dest),{recursive:true});writeFileSync(dest,bytes);}}}}
snapshot("src");snapshot("evaluation");for(const name of ["package.json","package-lock.json"]){const bytes=readFileSync(path.join(root,name));hashes[name]=createHash("sha256").update(bytes).digest("hex");if(!values.resume)writeFileSync(path.join(output,"snapshot",name),bytes);}
const bounds=(c:typeof cases[number])=>({maxCompletions:c.id.startsWith("background.")?16:8,timeoutMs:180000});
const sampling=(_c:typeof cases[number])=>({temperature:1,topP:.95});
const identity={schemaVersion:1,scope:"57 product-specific scenarios per candidate; isolated role probes, no integrated publication or local admission. Previously exposed heldout cases are reruns, not fresh holdout evidence.",profiles,cases,originalStockDigest:objectDigest({manifest:JSON.parse(readFileSync(new URL("benchmark.json",import.meta.url),"utf8")),cases:stock}),creativeSuiteDigest:objectDigest(creative),implementationDigest:objectDigest(hashes),files:hashes,priorBudget:prior,execution:cases.map(c=>({id:c.id,...bounds(c),sampling:sampling(c),exposure:c.split==="heldout"?"previously-exposed-heldout-rerun":"development"})),privacy:{zdr:true,data_collection:"deny",allow_fallbacks:false,require_parameters:true},concurrency:2};
const freeze=path.join(output,"freeze.json");if(existsSync(freeze)){if(objectDigest(JSON.parse(readFileSync(freeze,"utf8")))!==objectDigest(identity))throw new Error("Campaign resume refuses changed sources/cases/profiles/budget/settings");}else writeFileSync(freeze,JSON.stringify(identity,null,2)+"\n");
const ledgerFile=path.join(output,"budget-ledger.json");if(values.resume&&!existsSync(ledgerFile))throw new Error("Resume requires the existing budget ledger; missing exposure cannot be recreated");
const budget=new CampaignBudget(ledgerFile,prior);
if(values.prepare){console.log(JSON.stringify({prepared:output,scenarios:cases.length,candidates:profiles.length,expectedRuns:cases.length*profiles.length,implementationDigest:identity.implementationDigest,budget:budget.totals()}));process.exit(0);}
const apiKey=process.env.OPENROUTER_API_KEY;if(!apiKey)throw new Error("Explicit developer OPENROUTER_API_KEY required");
const reservations=new CampaignReservations(budget);
const jobs=cases.flatMap(fixture=>profiles.map(profile=>({fixture,profile})));let next=0;const rows:any[]=[];
function report(){writeFileSync(path.join(output,"report.json"),JSON.stringify({schemaVersion:1,runId:path.basename(output),freezeDigest:objectDigest(identity),expectedRuns:jobs.length,cases:rows,reportedCostUSD:budget.totals().reportedUSD,conservativeUnreportedUSD:budget.totals().reservedUSD,cumulativeBudget:budget.totals(),scope:identity.scope},null,2)+"\n");}
async function worker(){while(next<jobs.length){
 const {fixture,profile:base}=jobs[next++];const profile={...base,...sampling(fixture)};
 const name=profile.id.replaceAll("/","__")+"--"+fixture.id;const file=path.join(output,name+".json");
 const summarize=(r:any)=>({caseId:r.caseId,profile:r.profile,status:r.status,metrics:r.metrics,artifacts:[name+".json"],rubric:r.rubric,executionLimit:r.executionLimit});
 if(existsSync(file)){const old=JSON.parse(readFileSync(file,"utf8"));if(old.caseDigest!==objectDigest(fixture)||objectDigest(old.profile)!==objectDigest(profile))throw new Error("Receipt identity mismatch");if(!budget.entries[name])throw new Error("Receipt has no durable budget reservation");if(budget.entries[name].status==="reserved")budget.settle(name,old.metrics.costUSD,old.usageIncomplete);rows.push(summarize(old));continue;}
 if(budget.entries[name]){rows.push({caseId:fixture.id,profile,status:"interrupted_unmeasured",reason:"Durable reservation has no final receipt; exposure retained, no automatic replay."});report();continue;}
 const limits=bounds(fixture);const prices=profile.prices!;const exposure=limits.maxCompletions*(65536*Math.max(prices.input,prices.cacheRead,prices.cacheWrite)+profile.maxOutputTokens*prices.output)/1e6;
 if(!await reservations.acquire(name,exposure)){rows.push({caseId:fixture.id,profile,status:"budget_not_run"});report();continue;}
 const result=await runStockCase(fixture,profile,apiKey!,{...limits,shellHelperDirectory:path.join(output,"snapshot","evaluation","shell"),spendAvailable:()=>budget.totals().totalExposureUSD<=prior.ceilingUSD});
 result.executionLimit=/(completion_limit|stage_output_budget|screening_input_exposure_limit|screening_spend_limit)/.test(result.error??"")?result.error:result.turnOutcomes?.some((t:any)=>t.stopReason==="length")?"output_truncated":result.metrics.completions>=limits.maxCompletions&&result.stopReason!=="stop"?"completion_limit":null;
 result.exposureReserveUSD=exposure;result.rubric=fixture.rubric;result.artifacts=[name+".json"];result.exposure=fixture.split==="heldout"?"previously-exposed-heldout-rerun":"development";
 writeFileSync(file,JSON.stringify(result,null,2).split(apiKey!).join("[redacted credential]")+"\n");reservations.settle(name,result.metrics.costUSD,result.usageIncomplete);rows.push(summarize(result));report();
 console.log(JSON.stringify({candidate:profile.id,caseId:fixture.id,status:result.status,seconds:result.metrics.seconds,budget:budget.totals()}));
}}
await Promise.all([worker(),worker()]);report();releaseOwnership();console.log(JSON.stringify({finished:rows.length,...budget.totals()}));
