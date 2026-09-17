/** Versioned developer runner. Paid inference is explicit and never a product path. */
import {parseArgs} from "node:util";
import {readFileSync,writeFileSync,mkdirSync,existsSync,readdirSync,statSync,copyFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import path from "node:path";
import {execFileSync} from "node:child_process";
import {createHash} from "node:crypto";
import {runContracts} from "./contracts.ts";
import {loadStockCases,objectDigest} from "./stock-cases.ts";
import {runStockCase,type CandidateProfile} from "./stock.ts";
const {values}=parseArgs({options:{profiles:{type:"string"},output:{type:"string"},split:{type:"string",default:"development"},case:{type:"string"},cases:{type:"string"},"max-spend":{type:"string"},"max-completions":{type:"string",default:"8"},resume:{type:"boolean",default:false},validate:{type:"boolean",default:false},contracts:{type:"boolean",default:false},smoke:{type:"boolean",default:false},track:{type:"string",default:"agent"},browser:{type:"boolean",default:false}}});
const root=fileURLToPath(new URL("../",import.meta.url));
const manifest=JSON.parse(readFileSync(new URL("benchmark.json",import.meta.url),"utf8"));const allCases=loadStockCases();
if(values.contracts){if(!values.output)throw new Error("Explicit contract output path required");const r=runContracts(values.output);console.log(JSON.stringify({runId:r.runId,cases:r.cases.length,passed:r.cases.filter((c:any)=>c.status==="passed").length,failures:r.cases.filter((c:any)=>c.status!=="passed").length}));process.exit(0);}
if(values.validate){console.log(JSON.stringify({id:manifest.id,version:manifest.version,cases:allCases.length,development:allCases.filter(c=>c.split==="development").length,heldout:allCases.filter(c=>c.split==="heldout").length,families:[...new Set(allCases.map(c=>c.family))]}));process.exit(0);}
if(!values.profiles||!values.output||!values["max-spend"])throw new Error("Explicit profiles, output directory and maximum spend required");
if(!["development","heldout"].includes(values.split!))throw new Error("Choose development or heldout explicitly");
const apiKey:string=process.env.OPENROUTER_API_KEY??"";if(!apiKey)throw new Error("Explicit OPENROUTER_API_KEY required for developer inference");
const profiles:CandidateProfile[]=JSON.parse(readFileSync(values.profiles,"utf8"));
const maxSpend=Number(values["max-spend"]),maxCompletions=Number(values["max-completions"]);
if(!Number.isFinite(maxSpend)||maxSpend<=0||!Number.isSafeInteger(maxCompletions)||maxCompletions<1||!profiles.length)throw new Error("Invalid work limits");
if(new Set(profiles.map(p=>p.id)).size!==profiles.length)throw new Error("Candidate identities must be unique");
for(const p of profiles){if(typeof p.id!=="string"||!p.id||!Number.isSafeInteger(p.contextWindow)||!Number.isSafeInteger(p.maxOutputTokens)||p.maxOutputTokens<1||!Number.isSafeInteger(p.maxStageOutputTokens)||p.maxStageOutputTokens!<1||p.contextWindow<65536+p.maxOutputTokens||typeof p.reasoning!=="boolean"||!p.prices||[p.prices.input,p.prices.output,p.prices.cacheRead,p.prices.cacheWrite].some(n=>typeof n!=="number"||!Number.isFinite(n)||n<0))throw new Error("Candidate needs catalog identity, positive context/output/stage budgets and finite prices for bounded screening");}
if(values.browser){
 if(profiles.length!==1)throw new Error("Browser subset takes one explicit candidate profile");
 const p=profiles[0];const {runBrowserSubset}=await import("./browser.ts");
 const result=await runBrowserSubset({candidate:{model:p.id,name:p.name??p.id,thinkingLevel:p.thinkingLevel,maxInputTokens:65536,maxOutputTokens:p.maxOutputTokens,maxStageOutputTokens:p.maxStageOutputTokens!,inputUSDPerMillion:p.prices!.input,outputUSDPerMillion:p.prices!.output,maxRequests:100,maxCostUSD:maxSpend},output:values.output!,apiKey});
 console.log(JSON.stringify({runId:result.runId,cases:result.cases.map((c:any)=>({id:c.caseId,status:c.status})),reportedCostUSD:result.reportedCostUSD}));process.exit(0);
}
const selected=allCases.filter(c=>c.split===values.split&&(values.track==="all"||c.track===values.track)&&(!values.cases||values.cases.split(",").includes(c.id))&&(!values.smoke||manifest.smokeCaseIds.includes(c.id))&&(!values.case||c.id.includes(values.case)));
if(!selected.length)throw new Error("No cases selected");
const output=path.resolve(values.output);if(existsSync(output)&&!values.resume)throw new Error("Fresh output required (or explicit exact-identity resume)");mkdirSync(output,{recursive:true});
const sha=(s:string|Buffer)=>createHash("sha256").update(s).digest("hex");
const files:Record<string,string>={};
function snapshot(dir:string){for(const entry of readdirSync(path.join(root,dir))){const relative=path.join(dir,entry);const full=path.join(root,relative);if(statSync(full).isDirectory()){if(entry!=="__pycache__")snapshot(relative);}else if(/\.(ts|json|py|md)$/.test(entry)){const bytes=readFileSync(full);files[relative]=sha(bytes);const target=path.join(output,"snapshot",relative);if(!values.resume){mkdirSync(path.dirname(target),{recursive:true});writeFileSync(target,bytes);}}}}
snapshot("src");snapshot("evaluation");files["package-lock.json"]=sha(readFileSync(path.join(root,"package-lock.json")));
const implementation={revision:execFileSync("git",["rev-parse","HEAD"],{cwd:root,encoding:"utf8"}).trim(),dirtyDigest:objectDigest(files),files};
const identity={suiteDigest:objectDigest({manifest,cases:allCases}),implementationDigest:implementation.dirtyDigest,profiles,selected:selected.map(c=>c.id),split:values.split,maxCompletions,maxSpend};
const freezePath=path.join(output,"freeze.json");if(existsSync(freezePath)){const old=JSON.parse(readFileSync(freezePath,"utf8"));if(objectDigest(old)!==objectDigest(identity))throw new Error("Resume refuses changed suite, source, profile or limits");}else writeFileSync(freezePath,JSON.stringify(identity,null,2)+"\n");
let spent=0,reserved=0;const rows:any[]=[];let next=0;
const queue=selected.flatMap(fixture=>profiles.map(profile=>({profile,fixture})));
function report(){
 const data={schemaVersion:1,runId:path.basename(output),suite:{id:manifest.id,version:manifest.version,digest:identity.suiteDigest},implementation,profiles,cases:rows,reportedCostUSD:spent,conservativeUnreportedUSD:reserved,selectedCases:selected.length,expectedRuns:queue.length,missingFamilies:manifest.requiredFamilies.filter((family:string)=>!selected.some(c=>c.family===family)),scope:"Actual Pi loops/production prompts and tools; controlled library, hosted transport; no browser/local/retrieval admission implied."};
 writeFileSync(path.join(output,"report.json"),JSON.stringify(data,null,2).split(apiKey).join("[redacted credential]")+"\n");
 writeFileSync(path.join(output,"report.md"),`# ${manifest.id} ${manifest.version}\n\n${data.scope}\n\nReported cost: $${spent.toFixed(6)}. Unknown-usage reserve: $${reserved.toFixed(6)}.\n\n| Candidate | Case | Status | Seconds | Cost USD |\n|---|---|---|---:|---:|\n`+rows.map(r=>`| ${r.profile.id} | ${r.caseId} | ${r.status} | ${r.metrics.seconds.toFixed(2)} | ${r.metrics.costUSD.toFixed(6)} |`).join("\n")+"\n\nUnadjudicated cases are not passes. Review full source support and final memory state against each case rubric.\n");
}
async function worker(){while(next<queue.length){const {profile,fixture}=queue[next++];const filename=profile.id.replaceAll("/","__")+"--"+fixture.id+".json";const target=path.join(output,filename);
 if(existsSync(target)){const old=JSON.parse(readFileSync(target,"utf8"));if(old.caseDigest!==objectDigest(fixture)||objectDigest(old.profile)!==objectDigest(profile))throw new Error("Receipt identity mismatch");rows.push(old);spent+=old.metrics.costUSD;if(old.usageIncomplete)reserved+=old.exposureReserveUSD??0;continue;}
 const exposure=maxCompletions*(65536*profile.prices!.input+profile.maxOutputTokens*profile.prices!.output)/1e6;
 if(spent+reserved+exposure>maxSpend){rows.push({caseId:fixture.id,profile,status:"budget_not_run",metrics:{seconds:0,costUSD:0},checks:[]});report();continue;}
 reserved+=exposure;
 const result=await runStockCase(fixture,profile,apiKey,{maxCompletions,timeoutMs:180000,shellHelperDirectory:path.join(output,"snapshot","evaluation","shell"),spendAvailable:()=>spent<maxSpend});
 reserved-=exposure;spent+=result.metrics.costUSD;if(result.usageIncomplete)reserved+=exposure;result.exposureReserveUSD=exposure;result.rubric=fixture.rubric;result.artifacts=[filename];
 const serialized=JSON.stringify(result,null,2).split(apiKey).join("[redacted credential]");writeFileSync(target,serialized+"\n");rows.push(result);report();
 }}
await Promise.all([worker(),worker()]);report();
console.log(JSON.stringify({runId:path.basename(output),receipts:rows.length,reportedCostUSD:spent,unknownUsageReserveUSD:reserved,unadjudicated:rows.filter(r=>r.status==="unadjudicated").length}));
