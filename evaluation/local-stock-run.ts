/** Explicit local qualification runner; no hosted fallback and no automatic model launch. */
import { parseArgs } from "node:util";
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { prepareLocalStock, runtimeDigests } from "./local-stock.ts";
import { loadStockCases, objectDigest } from "./stock-cases.ts";
const {values}=parseArgs({options:{runtime:{type:"string"},gateway:{type:"string"},output:{type:"string"},split:{type:"string",default:"development"},track:{type:"string",default:"agent"},cases:{type:"string"},smoke:{type:"boolean"},"measure-only":{type:"boolean"},validate:{type:"boolean"},"max-completions":{type:"string",default:"8"},"timeout-ms":{type:"string",default:"180000"},"prepare-profile":{type:"string"},context:{type:"string"},"output-tokens":{type:"string"},"stage-output-tokens":{type:"string"}}});
const manifest=JSON.parse(readFileSync(new URL("benchmark.json",import.meta.url),"utf8"));const all=loadStockCases();
if(!["development","heldout"].includes(values.split!))throw new Error("Explicit development or heldout split required");
const ids=values.cases?.split(",");if(ids?.some(id=>!all.some(c=>c.id===id)))throw new Error("Unknown stock case");
if(!["agent","shell","all"].includes(values.track!))throw new Error("Choose agent, shell or all tracks");
const selected=all.filter(c=>(values.track==="all"||c.track===values.track)&&c.split===values.split&&(!ids||ids.includes(c.id))&&(!values.smoke||manifest.smokeCaseIds.includes(c.id)));
if(!selected.length)throw new Error("No stock agent cases selected");
if(values.validate){console.log(JSON.stringify({suite:manifest.id,version:manifest.version,selected:selected.map(c=>c.id),inference:false}));process.exit(0);}
if(!values.runtime)throw new Error("Explicit pinned runtime descriptor required");
const runtime=JSON.parse(readFileSync(values.runtime,"utf8"));const digests=runtimeDigests(runtime);
const positive=(text:string|undefined)=>{const n=Number(text);if(!Number.isSafeInteger(n)||n<1)throw new Error("Positive explicit integer limit required");return n;};
if(values["prepare-profile"]){
 const context=positive(values.context),output=positive(values["output-tokens"]),stage=positive(values["stage-output-tokens"]);
 if(output>=context||stage<output)throw new Error("Inconsistent candidate token bounds");
 const command:string[]=runtime.proposed_measurement.command;const id=command[command.indexOf("--served-model-name")+1];
 const runtimeFingerprint=objectDigest({runtime,context,output,stage}).slice(0,12);
 const profile={id:`${id}-${context}-${runtimeFingerprint}-candidate`,qualified:false,receipts:[],model:{id,name:runtime.repo,contextWindow:context,maxTokens:output,reasoning:true,input:["text"],parser:"vllm",quantization:runtime.repo.includes("W4A4")?"NVFP4 W4A4":"NVFP4 mixed precision",kvCache:{dtype:runtime.proposed_measurement.kv_cache_dtype??"auto",bytes:runtime.proposed_measurement.kv_cache_memory_bytes,attentionBackend:runtime.proposed_measurement.attention_backend??"auto"},...(runtime.proposed_measurement.sampling?{sampling:runtime.proposed_measurement.sampling}:{}),...digests},roles:Object.fromEntries(["chat","audit","memory","summary","compaction"].map(role=>[role,{maxInputTokens:context-output,maxOutputTokens:output,...(["audit","memory","summary"].includes(role)?{maxStageOutputTokens:stage}:{}),thinkingLevel:runtime.repo.includes("Muse-Glimmer")?"high":"medium"}])),limits:{queueCapacity:4,queueTimeoutMs:60000,executionTimeoutMs:180000,maxRequestBytes:1048576,backgroundMaxTokens:output,speechConcurrency:positive(String(runtime.proposed_measurement.speech_concurrency??2)),speechTimeoutMs:60000,speechMaxBytes:20971520}};
 writeFileSync(values["prepare-profile"],JSON.stringify(profile,null,2)+"\n",{flag:"wx"});console.log("Unqualified measurement profile written; no inference started.");process.exit(0);
}
if(!values.gateway||!values.output)throw new Error("Explicit loopback gateway and fresh output directory required");
const output=path.resolve(values.output);if(existsSync(output))throw new Error("Fresh output directory required");
const limits={maxCompletions:positive(values["max-completions"]),timeoutMs:positive(values["timeout-ms"]),measureOnly:values["measure-only"]===true};
const runner=await prepareLocalStock(values.gateway,runtime);
mkdirSync(output,{recursive:true});
const root=fileURLToPath(new URL("../",import.meta.url));const files:Record<string,string>={};
function snapshot(relative:string){const source=path.join(root,relative);for(const item of readdirSync(source)){const file=path.join(relative,item),full=path.join(root,file);if(statSync(full).isDirectory()){if(item!=="__pycache__")snapshot(file);}else if(/\.(ts|json|py|md)$/.test(item)){const bytes=readFileSync(full);files[file]=createHash("sha256").update(bytes).digest("hex");const target=path.join(output,"snapshot",file);mkdirSync(path.dirname(target),{recursive:true});writeFileSync(target,bytes);}}}
snapshot("src");snapshot("evaluation");snapshot("proxy");
for(const file of ["package-lock.json","proxy/bun.lock"]){const lock=readFileSync(path.join(root,file));files[file]=createHash("sha256").update(lock).digest("hex");writeFileSync(path.join(output,"snapshot",file),lock);}
const identity={suite:{id:manifest.id,version:manifest.version,digest:objectDigest({manifest,cases:all})},implementation:{digest:objectDigest(files),files},runtime:runner.identity,selected:selected.map(c=>c.id),limits};
writeFileSync(path.join(output,"freeze.json"),JSON.stringify(identity,null,2)+"\n");
const rows:any[]=[];
for(const fixture of selected){
 const result=await runner.run(fixture,{...limits,shellHelperDirectory:path.join(output,"snapshot","evaluation","shell")});const filename=result.profile.id.replaceAll("/","__")+"--"+fixture.id+".json";
 result.artifacts=[filename];writeFileSync(path.join(output,filename),JSON.stringify(result,null,2)+"\n");rows.push(result);
 writeFileSync(path.join(output,"report.json"),JSON.stringify({schemaVersion:1,runId:path.basename(output),...identity,cases:rows,expectedRuns:selected.length,scope:"Stock Pi scenarios and controlled source fixtures through production local exact-count admission. Local model quality requires semantic adjudication; this is not production retrieval, speech-overlap or release admission."},null,2)+"\n");
 console.log(JSON.stringify({caseId:fixture.id,status:result.status,metrics:result.metrics}));
}
