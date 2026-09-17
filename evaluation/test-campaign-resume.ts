import assert from "node:assert/strict";
import {mkdtempSync,writeFileSync,readFileSync,rmSync,symlinkSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {spawnSync} from "node:child_process";
const dir=mkdtempSync(join(tmpdir(),"almanac-resume-"));
try{
 const profiles=JSON.parse(readFileSync(new URL("./candidates.json",import.meta.url),"utf8")).map((p:any)=>({...p,providerRouting:{only:["synthetic"],order:["synthetic"]}}));
 const profilesFile=join(dir,"profiles.json"),prior=join(dir,"prior.json"),output=join(dir,"run");
 writeFileSync(profilesFile,JSON.stringify(profiles));writeFileSync(prior,JSON.stringify({ceilingUSD:10,priorReportedUSD:0,priorUnknownReserveUSD:0}));
 const exe=fileURLToPath(new URL("../node_modules/.bin/tsx",import.meta.url)),runner=fileURLToPath(new URL("./campaign-run.ts",import.meta.url));
 const args=[runner,"--profiles",profilesFile,"--prior-budget",prior,"--output",output];const options={encoding:"utf8" as const,env:{...process.env,OPENROUTER_API_KEY:""},timeout:30000};
 const prepared=spawnSync(exe,[...args,"--prepare"],options);assert.equal(prepared.status,0,prepared.stderr);
 const snapshot=join(output,"snapshot");
 assert.equal(JSON.parse(readFileSync(join(snapshot,"package.json"),"utf8")).type,"module");
 const freeze=JSON.parse(readFileSync(join(output,"freeze.json"),"utf8"));assert(freeze.files["package.json"]);assert(freeze.files["package-lock.json"]);
 symlinkSync(fileURLToPath(new URL("../node_modules",import.meta.url)),join(snapshot,"node_modules"),"dir");
 const relocated=spawnSync(exe,[join(snapshot,"evaluation/campaign-run.ts"),"--profiles",profilesFile,"--prior-budget",prior,"--output",join(dir,"relocated"),"--prepare"],options);
 assert.equal(relocated.status,0,relocated.stderr);assert.equal(JSON.parse(relocated.stdout).expectedRuns,570);
 rmSync(join(output,"budget-ledger.json"));
 const resumed=spawnSync(exe,[...args,"--resume"],options);assert.notEqual(resumed.status,0);assert.match(resumed.stderr,/Resume requires the existing budget ledger/);
 console.log("Actual campaign resume fails closed when the persisted ledger is missing; no inference or credentials used.");
}finally{rmSync(dir,{recursive:true,force:true});}
