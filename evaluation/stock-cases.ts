import {readFileSync} from "node:fs";
import {createHash} from "node:crypto";
import {shellCases,type ShellCase} from "./shell/index.ts";
import {roleCases, type RoleCase} from "./roles.ts";
import type {FixtureContext} from "./library.ts";
export interface StockCase {id:string;split:"development"|"heldout";track:"agent"|"shell";shellCase?:ShellCase;family:string;description:string;steps:{action:"send";text:string}[];contexts?:FixtureContext[];roleCase?:RoleCase;fault?:{kind:"maintenance-peer-edit";label:string;description:string};assertions:{id:string;kind:string;critical:boolean}[];rubric:string[];}
export const objectDigest=(value:unknown)=>createHash("sha256").update(JSON.stringify(value)).digest("hex");
export function loadStockCases():StockCase[]{
 const cases:StockCase[]=[];
 for(const filename of ["fixtures.json","workflows.json"]){
  const suite=JSON.parse(readFileSync(new URL(filename,import.meta.url),"utf8"));
  for(const c of suite.cases){
   cases.push({id:`research.${c.id}`,split:c.split,track:"agent",family:"research",description:c.question,steps:[{action:"send",text:c.question}],contexts:c.gold_context.map((key:string)=>({...suite.contexts[key],title:suite.sources[suite.contexts[key].source_sha256].title})),assertions:[{id:"valid_completion",kind:"completion",critical:true},{id:"source_identity",kind:"citation_identity",critical:true},{id:"corpus_used",kind:"corpus_used",critical:true},{id:"read_source",kind:"read_source",critical:true}],rubric:c.requirements.map((r:any)=>r.rubric)});
  }
 }
 for(const original of roleCases){const c=original.id==="first-merge-sighting"?{...original,id:"queued-equivalent-pair",transcript:"User: The rain-barrel and rainwater-barrel labels describe the same single rooftop barrel. Review their queued pair using both current definitions.\nAssistant: This is the first dedicated review of the queued pair.",rubric:["Dedicated maintenance_review may merge the confirmed equivalent pair on first review after inspecting both current definitions, preserving premerge evidence. Generic merge_terms still requires recurrence; do not use similarity alone as identity."]}:original;cases.push({id:`${c.role}.${c.id}`,split:c.split,track:"agent",family:c.role,description:c.rubric.join(" "),steps:[{action:"send",text:c.transcript}],roleCase:c,assertions:c.memoryConsent?[{id:"valid_completion",kind:"completion",critical:true},{id:"schema_validity",kind:"tool_schema",critical:true}]:[{id:"consent",kind:"consent",critical:true}],rubric:c.rubric});}
 const maintenance=JSON.parse(readFileSync(new URL("maintenance-scenarios.json",import.meta.url),"utf8"));cases.push(...maintenance.cases);
 const synthetic=JSON.parse(readFileSync(new URL("scenarios.json",import.meta.url),"utf8"));
 cases.push(...synthetic.cases);
 for(const shellCase of shellCases)cases.push({...shellCase,shellCase});
 if(cases.some(c=>!/^[-a-zA-Z0-9_.]+$/.test(c.id)))throw new Error("Invalid scenario identifier");
 if(new Set(cases.map(c=>c.id)).size!==cases.length)throw new Error("Duplicate benchmark case ID");
 return cases;
}
