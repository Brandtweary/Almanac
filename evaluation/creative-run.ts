/** Local-only comparison of two frozen production prompt-builder outputs. No speech. */
import {parseArgs} from "node:util";
import {readFileSync,writeFileSync,mkdirSync,existsSync} from "node:fs";
import path from "node:path";
import {pathToFileURL} from "node:url";
import {createHash} from "node:crypto";
import {prepareLocalStock} from "./local-stock.ts";
import {objectDigest,loadStockCases} from "./stock-cases.ts";
import {loadCreativeSuite} from "./creative.ts";
const {values}=parseArgs({options:{runtime:{type:"string"},gateway:{type:"string"},baseline:{type:"string"},revised:{type:"string"},prompt:{type:"string"},cases:{type:"string"},output:{type:"string"},validate:{type:"boolean"},"max-completions":{type:"string",default:"8"},"timeout-ms":{type:"string",default:"180000"}}});
const suite=loadCreativeSuite();
const selectedIds=values.cases?.split(",");
if(selectedIds&&(new Set(selectedIds).size!==selectedIds.length||selectedIds.some(id=>!suite.cases.some(c=>c.id===id))))throw new Error("Unknown or duplicate creative case selection");
const selected=suite.cases.filter(c=>!selectedIds||selectedIds.includes(c.id));
if(values.prompt&&(values.baseline||values.revised))throw new Error("Choose either single prompt or paired baseline/revised sources");
if(values.validate){console.log(JSON.stringify({suite:suite.id,version:suite.version,cases:selected.map(c=>c.id),unchangedStockCases:loadStockCases().length,inference:false}));process.exit(0);}
if(!values.runtime||!values.gateway||(!values.prompt&&(!values.baseline||!values.revised))||!values.output)throw new Error("Explicit runtime, loopback gateway, single prompt or baseline/revised production prompt sources and fresh output required");
const positive=(v:string|undefined)=>{const n=Number(v);if(!Number.isSafeInteger(n)||n<1)throw new Error("Positive experiment limit required");return n;};
const limits={maxCompletions:positive(values["max-completions"]),timeoutMs:positive(values["timeout-ms"])};
const output=path.resolve(values.output);if(existsSync(output))throw new Error("Fresh output directory required");
mkdirSync(path.dirname(output),{recursive:true});mkdirSync(output);
const runtime=JSON.parse(readFileSync(values.runtime,"utf8"));const runner=await prepareLocalStock(values.gateway,runtime);
const variants:any[]=[];
const sources=values.prompt?[["current",values.prompt]]:[["baseline",values.baseline!],["revised",values.revised!]];
for(const [id,file] of sources){
 const source=readFileSync(file);const module=await import(pathToFileURL(path.resolve(file)).href);
 if(typeof module.buildOraclePrompt!=="function")throw new Error("Source must export the production buildOraclePrompt function");
 const text=module.buildOraclePrompt({modelName:runner.identity.profile.model.name});if(typeof text!=="string"||!text.trim())throw new Error("Invalid production prompt output");
 const sourceDigest=createHash("sha256").update(source).digest("hex");
 writeFileSync(path.join(output,`${id}-oracle-prompts.ts`),source);writeFileSync(path.join(output,`${id}-system-prompt.txt`),text);
 variants.push({id,text,sourceDigest,promptDigest:objectDigest(text)});
}
if(variants.length===2&&variants[0].promptDigest===variants[1].promptDigest)throw new Error("Comparison prompts are identical");
const identity={schemaVersion:1,suite:{id:suite.id,version:suite.version,digest:objectDigest(suite),cases:selected,selectedIds:selected.map(c=>c.id)},runtime:runner.identity,limits,variants,scope:"Single sampled local trajectory per case and prompt; qualitative comparison, not a model landscape or statistical preference estimate. Original stock cases unchanged."};
writeFileSync(path.join(output,"freeze.json"),JSON.stringify(identity,null,2)+"\n");
const rows:any[]=[];
for(const [index,fixture] of selected.entries()){
 for(const variant of index%2?[...variants].reverse():variants){
  const result=await runner.run(fixture,{...limits,creativePrompt:{text:variant.text,sourceDigest:variant.sourceDigest}});
  const file=`${variant.id}--${fixture.id}.json`;result.promptVariant=variant.id;result.artifacts=[file];
  writeFileSync(path.join(output,file),JSON.stringify(result,null,2)+"\n");rows.push(result);
  writeFileSync(path.join(output,"report.json"),JSON.stringify({...identity,cases:rows,expectedRuns:selected.length*variants.length},null,2)+"\n");
  console.log(JSON.stringify({variant:variant.id,caseId:fixture.id,status:result.status,metrics:result.metrics}));
 }
}
