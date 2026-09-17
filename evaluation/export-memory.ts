/** Export current production role prompts/tool schemas without calling a model. */
import {writeFileSync} from "node:fs";
import {createHash} from "node:crypto";
import {createPipelineTools} from "../src/pipeline-tools.ts";
import {PIPELINE_SYSTEM_STUB,buildAuditInstructions,buildMemoryManagerInstructions,buildSummaryInstructions} from "../src/pipeline-prompts.ts";
import {createMemoryInspector,inspectionPage} from "../src/memory-context.ts";
import {assembleMemoryRoleTools,createStageOutcomeTool,createSummaryDraftTool,createAuditHandoffTool,createRoleArchiveTool} from "../src/memory-handoffs.ts";
import {COMPACTION_INSTRUCTIONS} from "../src/oracle-context.ts";
import {MAINTENANCE_INSTRUCTIONS,emptyMaintenance,prepareMaintenance,createMaintenanceTool} from "../src/glossary-maintenance.ts";
import {Graph} from "../src/kg/graph.ts";
import {emptySttLexicon} from "../src/stt-lexicon.ts";
const graph=Graph.empty(),stt=emptySttLexicon();
const maintenance=emptyMaintenance();prepareMaintenance(graph,maintenance);
const maintenanceTool=createMaintenanceTool({graph,state:maintenance,assertActive:()=>{},record:()=>{},onMerge:()=>{}});
const mutationTools=createPipelineTools({maintenance,getGraph:()=>graph,getSttLexicon:()=>stt,embed:async()=>null,addFlag:()=>{},record:()=>{}});
const inspector=createMemoryInspector({records:()=>[],assertActive:()=>{},page:async(record,collection,cursor)=>inspectionPage(record,collection,cursor,record.text.slice(cursor),record.text.length)});
const finish=createStageOutcomeTool({finish:()=>{}}),summaryDraft=createSummaryDraftTool({read:()=>"",store:()=>{},abstain:()=>{},maxWords:8000}),auditHandoff=createAuditHandoffTool({put:()=>{}}),archive=createRoleArchiveTool({read:async()=>({records:[],next:null})});
const ctx={bufferBlock:"Read memory_inspect(actions,id=committed) for prior actions; draft actions are actions/draft.",isVoiceTurn:false};
const roles:Record<string,unknown>={};
for(const role of ["audit","memory","summary"] as const){const tools=assembleMemoryRoleTools(role,{mutationTools,inspector,finish,summaryDraft,auditHandoff,archive});if(role==="memory")tools.push(maintenanceTool);roles[role]={system:PIPELINE_SYSTEM_STUB,instructions:role==="audit"?buildAuditInstructions(ctx):role==="memory"?buildMemoryManagerInstructions(ctx)+"\n"+MAINTENANCE_INSTRUCTIONS:buildSummaryInstructions("Read summaries and working_summary through memory_inspect."),tools:tools.map(t=>({type:"function",function:{name:t.name,description:t.description,parameters:t.parameters}}))};}
roles.compaction={system:COMPACTION_INSTRUCTIONS,tools:[]};
if(!process.argv[2])throw new Error("Supply an explicit developer artifact output path");
writeFileSync(process.argv[2],JSON.stringify({schemaVersion:1,roles,sha256:createHash("sha256").update(JSON.stringify(roles)).digest("hex")},null,2)+"\n");
