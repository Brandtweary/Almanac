import assert from "node:assert/strict";
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from "node:fs";
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
 rmSync(join(output,"budget-ledger.json"));
 const resumed=spawnSync(exe,[...args,"--resume"],options);assert.notEqual(resumed.status,0);assert.match(resumed.stderr,/Resume requires the existing budget ledger/);
 console.log("Actual campaign resume fails closed when the persisted ledger is missing; no inference or credentials used.");
}finally{rmSync(dir,{recursive:true,force:true});}
