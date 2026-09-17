import {readFileSync,writeFileSync,mkdirSync,existsSync} from "node:fs";
import {spawnSync,execFileSync} from "node:child_process";
import {fileURLToPath} from "node:url";
import {createHash} from "node:crypto";
export function runContracts(output:string){
 if(existsSync(output))throw new Error("Fresh contract receipt directory required");mkdirSync(output,{recursive:true});
 const root=fileURLToPath(new URL("../",import.meta.url));const suite=JSON.parse(readFileSync(new URL("contracts.json",import.meta.url),"utf8"));const cases:any[]=[];
 for(const group of suite.groups){const started=performance.now();const result=spawnSync(`${root}/node_modules/.bin/tsx`,["--test","--test-reporter=tap",group.file],{cwd:root,encoding:"utf8",timeout:30000,env:{...process.env,OPENROUTER_API_KEY:""}});const transcript=result.stdout+result.stderr;writeFileSync(`${output}/${group.id}.tap`,transcript);
  const rows=[...transcript.matchAll(/^(not )?ok \d+ - (.+)$/gm)];
  if(!rows.length)cases.push({caseId:group.id,track:"contract",family:group.family,status:"evaluator_error",checks:[{id:"test_execution",passed:false,critical:true,evidence:result.error?.message??`exit ${result.status}; no TAP cases`}],artifacts:[`${group.id}.tap`]});
  for(const row of rows)cases.push({caseId:`${group.id}.${createHash("sha256").update(row[2]).digest("hex").slice(0,12)}`,description:row[2],track:"contract",family:group.family,status:row[1]?"failed":"passed",checks:[{id:"fault_contract",passed:!row[1],critical:true,evidence:row[2]}],metrics:{seconds:(performance.now()-started)/1000,inputTokens:0,outputTokens:0,costUSD:0},artifacts:[`${group.id}.tap`]});
  if(result.status!==0&&!rows.some(r=>r[1]))cases.push({caseId:`${group.id}.process`,status:"evaluator_error",error:result.error?.message??`exit ${result.status}`});
 }
 const report={schemaVersion:1,runId:output.split('/').at(-1),suiteDigest:createHash("sha256").update(JSON.stringify(suite)).digest("hex"),implementation:{revision:execFileSync("git",["rev-parse","HEAD"],{cwd:root,encoding:"utf8"}).trim()},cases,reportedCostUSD:0};writeFileSync(`${output}/report.json`,JSON.stringify(report,null,2)+"\n");return report;
}
