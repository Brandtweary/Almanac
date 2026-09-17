/** Explicit missing-case routing amendment; shares the completed campaign's budget owner. */
import {parseArgs} from "node:util";
import {readFileSync,writeFileSync,existsSync,mkdirSync} from "node:fs";
import path from "node:path";
import {pathToFileURL} from "node:url";
import {createHash} from "node:crypto";
import {isZeroGenerationRoutingFailure} from "./replay-policy.ts";
const {values}=parseArgs({options:{campaign:{type:"string"},amendment:{type:"string"},output:{type:"string"},prepare:{type:"boolean"}}});
if(!values.campaign||!values.amendment||!values.output)throw new Error("Explicit campaign, frozen routing amendment and fresh output required");
const sha=(b:string|Buffer)=>createHash("sha256").update(b).digest("hex");
const campaign=path.resolve(values.campaign),output=path.resolve(values.output),snapshot=path.join(campaign,"snapshot");
const freezeBytes=readFileSync(path.join(campaign,"freeze.json")),freeze=JSON.parse(freezeBytes.toString());
const amendmentBytes=readFileSync(values.amendment),amendment=JSON.parse(amendmentBytes.toString());
if(sha(freezeBytes)!==amendment.sourceFreezeSHA256||freeze.implementationDigest!==amendment.implementationDigest)throw new Error("Amendment does not bind this frozen source campaign");
for(const [file,digest] of Object.entries(freeze.files))if(sha(readFileSync(path.join(snapshot,file)))!==digest)throw new Error(`Frozen source mismatch: ${file}`);
if(amendment.privacy.zdr!==true||amendment.privacy.data_collection!=="deny"||amendment.candidate.providerRouting.only.length!==1)throw new Error("Explicit private routing pin required");
const ids=new Set(amendment.caseIds);if(ids.size!==amendment.caseIds.length||[...ids].some(id=>!freeze.cases.some((c:any)=>c.id===id)))throw new Error("Amendment contains unknown or duplicate cases");
if(values.prepare){console.log(JSON.stringify({sourceVerified:true,possibleCases:ids.size,model:amendment.candidate.id,provider:amendment.candidate.providerRouting,inference:false}));process.exit(0);}
const key=process.env.OPENROUTER_API_KEY;if(!key)throw new Error("Explicit developer credential required");
const {CampaignBudget,claimCampaign}=await import(pathToFileURL(path.join(snapshot,"evaluation/campaign-budget.ts")).href);
const release=claimCampaign(campaign);
const ledgerFile=path.join(campaign,"budget-ledger.json");if(!existsSync(ledgerFile))throw new Error("Existing cumulative ledger required");
const budget=new CampaignBudget(ledgerFile,freeze.priorBudget);
const main=JSON.parse(readFileSync(path.join(campaign,"report.json"),"utf8"));
if(main.cases.length!==main.expectedRuns||Object.values(budget.entries).some((e:any)=>e.status==="reserved"))throw new Error("Main campaign must finish and settle before replay");
if(existsSync(output))throw new Error("Fresh amendment output required");mkdirSync(path.dirname(output),{recursive:true});mkdirSync(output);
const {runStockCase}=await import(pathToFileURL(path.join(snapshot,"evaluation/stock.ts")).href);
const amendmentSHA256=sha(amendmentBytes),rows:any[]=[];
writeFileSync(path.join(output,"freeze.json"),JSON.stringify({amendment,amendmentSHA256,runnerSHA256:sha(readFileSync(new URL(import.meta.url))),replayPolicySHA256:sha(readFileSync(new URL("./replay-policy.ts",import.meta.url))),scope:"Only explicit zero-generation routing rejections, frozen production source; provider amendment, original receipts retained; same cumulative budget."},null,2)+"\n");
function report(){writeFileSync(path.join(output,"report.json"),JSON.stringify({schemaVersion:1,amendmentSHA256,cases:rows,cumulativeBudget:budget.totals()},null,2)+"\n");}
for(const fixture of freeze.cases.filter((c:any)=>ids.has(c.id))){
 const filename=amendment.candidate.id.replaceAll("/","__")+"--"+fixture.id+".json";const original=path.join(campaign,filename);
 const previous=existsSync(original)?JSON.parse(readFileSync(original,"utf8")):main.cases.find((c:any)=>c.caseId===fixture.id&&c.profile.id===amendment.candidate.id);
 if(!previous||!isZeroGenerationRoutingFailure(previous)){rows.push({caseId:fixture.id,status:"not_replayed_ineligible",originalStatus:previous?.status});report();continue;}
 const limits=freeze.execution.find((c:any)=>c.id===fixture.id);const profile={...amendment.candidate,...limits.sampling};
 if(JSON.stringify(limits.sampling)!==JSON.stringify(amendment.sampling))throw new Error("Sampling amendment is not authorized");
 const rate=profile.prices,exposure=limits.maxCompletions*(65536*Math.max(rate.input,rate.cacheRead,rate.cacheWrite)+profile.maxOutputTokens*rate.output)/1e6,id=`amendment-${amendmentSHA256}-${filename}`;
 if(!budget.reserve(id,exposure)){rows.push({caseId:fixture.id,status:"budget_not_run"});report();continue;}
 const result=await runStockCase(fixture,profile,key,{maxCompletions:limits.maxCompletions,timeoutMs:limits.timeoutMs,shellHelperDirectory:path.join(snapshot,"evaluation/shell"),spendAvailable:()=>budget.totals().totalExposureUSD<=freeze.priorBudget.ceilingUSD});
 result.rubric=fixture.rubric;result.artifacts=[filename];result.routingAmendment={sha256:amendmentSHA256,originalReceiptSHA256:existsSync(original)?sha(readFileSync(original)):null,sourceImplementationDigest:freeze.implementationDigest};
 writeFileSync(path.join(output,filename),JSON.stringify(result,null,2).split(key).join("[redacted credential]")+"\n");budget.settle(id,result.metrics.costUSD,result.usageIncomplete);rows.push({caseId:fixture.id,status:result.status,metrics:result.metrics,artifacts:[filename]});report();console.log(JSON.stringify({caseId:fixture.id,status:result.status,budget:budget.totals()}));
}
release();report();
