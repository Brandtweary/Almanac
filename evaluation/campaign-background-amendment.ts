/** Versioned corrected-fixture study; no replacement of prior measured model outcomes. */
import {parseArgs} from "node:util";
import {readFileSync,writeFileSync,existsSync,mkdirSync,readdirSync,statSync,symlinkSync} from "node:fs";
import path from "node:path";
import {fileURLToPath,pathToFileURL} from "node:url";
import {createHash} from "node:crypto";
const {values}=parseArgs({options:{campaign:{type:"string"},output:{type:"string"},"gemma-routing":{type:"string"},"routing-results":{type:"string"},prepare:{type:"boolean"}}});
if(!values.campaign||!values.output||!values["gemma-routing"]||!values["routing-results"])throw new Error("Explicit original campaign, authorized routing amendment/results and output required");
const sha=(bytes:string|Buffer)=>createHash("sha256").update(bytes).digest("hex");
const campaign=path.resolve(values.campaign),output=path.resolve(values.output),source=fileURLToPath(new URL("../",import.meta.url));
const baseBytes=readFileSync(path.join(campaign,"freeze.json")),base=JSON.parse(baseBytes.toString());
const route=JSON.parse(readFileSync(values["gemma-routing"],"utf8"));if(route.sourceFreezeSHA256!==sha(baseBytes))throw new Error("Routing amendment belongs to another campaign");
const freezeFile=path.join(output,"freeze.json"),snapshot=path.join(output,"snapshot");
if(values.prepare){
 if(existsSync(output))throw new Error("Fresh corrected-fixture output required");mkdirSync(path.dirname(output),{recursive:true});mkdirSync(output);
 const {loadBackgroundSanityV3Cases}=await import("./background-sanity.ts");const cases=loadBackgroundSanityV3Cases();
 if(cases.length!==3||new Set(cases.map(c=>c.id)).size!==3||cases.some(c=>!c.id.startsWith("background.")||!c.id.endsWith("-v3")))throw new Error("Unexpected corrected fixture inventory");
 const files:Record<string,string>={};
 function copy(relative:string){const full=path.join(source,relative);if(statSync(full).isDirectory()){for(const name of readdirSync(full))if(name!=="__pycache__")copy(path.join(relative,name));}else if(/\.(ts|json|py|md)$/.test(relative)){const bytes=readFileSync(full);files[relative]=sha(bytes);const dest=path.join(snapshot,relative);mkdirSync(path.dirname(dest),{recursive:true});writeFileSync(dest,bytes);}}
 copy("src");copy("evaluation");copy("package.json");copy("package-lock.json");symlinkSync(path.join(source,"node_modules"),path.join(snapshot,"node_modules"),"dir");
 const profiles=base.profiles.map((p:any)=>({...(p.id===route.candidate.id?route.candidate:p),temperature:1,topP:.95}));
 const freeze={schemaVersion:1,kind:"corrected-background-fixture-v3",originalCampaignSHA256:sha(baseBytes),routingAmendmentSHA256:sha(readFileSync(values["gemma-routing"])),cases,profiles,files,implementationDigest:sha(JSON.stringify(files)),maxCompletions:16,timeoutMs:180000,expectedRuns:30,scope:"All ten candidates receive all three corrected fixtures. Original measured outcomes remain diagnostic and are never replaced. Same cumulative campaign ledger and privacy policy; isolated audit roles, not integrated publication admission."};
 writeFileSync(freezeFile,JSON.stringify(freeze,null,2)+"\n");console.log(JSON.stringify({prepared:true,cases:cases.map(c=>c.id),expectedRuns:30,implementationDigest:freeze.implementationDigest,inference:false}));process.exit(0);
}
const freeze=JSON.parse(readFileSync(freezeFile,"utf8"));if(freeze.originalCampaignSHA256!==sha(baseBytes)||freeze.routingAmendmentSHA256!==sha(readFileSync(values["gemma-routing"])))throw new Error("Corrected study identity mismatch");
for(const [file,digest] of Object.entries(freeze.files))if(sha(readFileSync(path.join(snapshot,file)))!==digest)throw new Error(`Corrected source snapshot mismatch: ${file}`);
const key=process.env.OPENROUTER_API_KEY;if(!key)throw new Error("Explicit developer credential required");
const {CampaignBudget,claimCampaign}=await import(pathToFileURL(path.join(campaign,"snapshot/evaluation/campaign-budget.ts")).href);const release=claimCampaign(campaign);
const ledgerFile=path.join(campaign,"budget-ledger.json");if(!existsSync(ledgerFile))throw new Error("Existing shared ledger required");const budget=new CampaignBudget(ledgerFile,base.priorBudget);
const main=JSON.parse(readFileSync(path.join(campaign,"report.json"),"utf8"));if(main.cases.length!==main.expectedRuns||Object.values(budget.entries).some((e:any)=>e.status==="reserved"))throw new Error("Main/replay reservations must settle before corrected study");
const routingReport=JSON.parse(readFileSync(path.join(path.resolve(values["routing-results"]!),"report.json"),"utf8"));
if(routingReport.amendmentSHA256!==freeze.routingAmendmentSHA256||routingReport.cases.length!==route.caseIds.length)throw new Error("Authorized routing replay must finish before corrected study");
const {runStockCase}=await import(pathToFileURL(path.join(snapshot,"evaluation/stock.ts")).href);const rows:any[]=[];const studyHash=sha(readFileSync(freezeFile));
function report(){writeFileSync(path.join(output,"report.json"),JSON.stringify({schemaVersion:1,studyHash,expectedRuns:30,cases:rows,cumulativeBudget:budget.totals(),scope:freeze.scope},null,2)+"\n");}
for(const fixture of freeze.cases)for(const profile of freeze.profiles){
 const filename=profile.id.replaceAll("/","__")+"--"+fixture.id+".json",file=path.join(output,filename),id=`corrected-${studyHash}-${filename}`;
 if(existsSync(file)){const previous=JSON.parse(readFileSync(file,"utf8"));if(previous.correctedStudyHash!==studyHash||!budget.entries[id])throw new Error("Corrected receipt/ledger mismatch");if(budget.entries[id].status==="reserved")budget.settle(id,previous.metrics.costUSD,previous.usageIncomplete);rows.push({caseId:fixture.id,profile,status:previous.status,artifacts:[filename],metrics:previous.metrics});continue;}
 if(budget.entries[id]){rows.push({caseId:fixture.id,profile,status:"interrupted_unmeasured"});report();continue;}
 const p=profile.prices,exposure=freeze.maxCompletions*(65536*Math.max(p.input,p.cacheRead,p.cacheWrite)+profile.maxOutputTokens*p.output)/1e6;
 if(!budget.reserve(id,exposure)){rows.push({caseId:fixture.id,profile,status:"budget_not_run"});report();continue;}
 const result=await runStockCase(fixture,profile,key,{maxCompletions:freeze.maxCompletions,timeoutMs:freeze.timeoutMs,spendAvailable:()=>budget.totals().totalExposureUSD<=base.priorBudget.ceilingUSD});
 result.correctedStudyHash=studyHash;result.rubric=fixture.rubric;result.artifacts=[filename];writeFileSync(file,JSON.stringify(result,null,2).split(key).join("[redacted credential]")+"\n");budget.settle(id,result.metrics.costUSD,result.usageIncomplete);rows.push({caseId:fixture.id,profile,status:result.status,artifacts:[filename],metrics:result.metrics});report();console.log(JSON.stringify({candidate:profile.id,caseId:fixture.id,status:result.status,budget:budget.totals()}));
}
report();release();
