/** Actual Pi-loop scenario execution using production prompts and tools. */
import {AsyncLocalStorage} from "node:async_hooks";
import {createHash} from "node:crypto";
import {runAgentLoop,type AgentMessage,type AgentTool,type StreamFn} from "@earendil-works/pi-agent-core";
import type {Model,ThinkingLevel} from "@earendil-works/pi-ai";
import {MYRIAPOD_PROXY_BASE} from "../src/myriapod-model.ts";
import {streamSimple} from "../src/pi-ai-slim-compat.ts";
import {buildOraclePrompt} from "../src/oracle-prompts.ts";
import {ConversationHistory,createConversationHistoryTool} from "../src/conversation-history.ts";
import {EvidenceLedger,createCorpusTools,inspectCorpusCitations} from "../src/corpus-tools.ts";
import {createPipelineTools} from "../src/pipeline-tools.ts";
import {createMemorySearchTool,createMemoryDumpTool} from "../src/memory-tools.ts";
import {createMemoryInspector,inspectionPage,type InspectionRecord} from "../src/memory-context.ts";
import {PIPELINE_SYSTEM_STUB,buildAuditInstructions,buildMemoryManagerInstructions,buildSummaryInstructions} from "../src/pipeline-prompts.ts";
import {COMPACTION_INSTRUCTIONS} from "../src/oracle-context.ts";
import {emptySttLexicon} from "../src/stt-lexicon.ts";
import {assembleMemoryRoleTools,createStageOutcomeTool,createSummaryDraftTool,createAuditHandoffTool,createRoleArchiveTool,validateMemoryWindowOutcome,type StageOutcome} from "../src/memory-handoffs.ts";
import {validatedTokenUsage,addTokenUsage} from "../src/token-usage.ts";
import {MAINTENANCE_INSTRUCTIONS,emptyMaintenance,prepareMaintenance,createMaintenanceTool} from "../src/glossary-maintenance.ts";
import {Graph} from "../src/kg/graph.ts";
import {verifyConsentOff} from "./contract-runtime.ts";
import {prepareShellCase,createShellTool,type ShellSession} from "./shell/index.ts";
import {FixtureLibrary} from "./library.ts";
import {objectDigest,type StockCase} from "./stock-cases.ts";

export interface CandidateProfile {id:string;name?:string;contextWindow:number;maxOutputTokens:number;maxStageOutputTokens?:number;providerRouting?:{only?:string[];order?:string[]};reasoning:boolean;thinkingLevel?:ThinkingLevel;prices?:{input:number;output:number;cacheRead:number;cacheWrite:number};}
const libraries=new AsyncLocalStorage<{library:FixtureLibrary;observe:(response:Response)=>void}>();
const networkFetch=globalThis.fetch;
let installed=false;
export function installFixtureTransport(){
 if(installed)return;installed=true;
 globalThis.fetch=async(input,init)=>{
  const url=typeof input==="string"?input:input instanceof URL?input.href:input.url;
  if(url.startsWith(`${MYRIAPOD_PROXY_BASE}/corpus/`)){
   const library=libraries.getStore()?.library;if(!library)throw new Error("No scenario library context");
   const kind=url.split("/").at(-1);
   if(kind!=="search"&&kind!=="read")return new Response("not found",{status:404});
   try{return Response.json(library.handle(kind,JSON.parse(String(init?.body??"{}"))));}
   catch(error){return Response.json({error:error instanceof Error?error.message:"fixture_error"},{status:400});}
  }
  const response=await networkFetch(input,init);
  if(url.startsWith("https://openrouter.ai/api/v1/chat/completions"))libraries.getStore()?.observe(response);
  return response;
 };
}
export function withFixtureLibrary<T>(library:FixtureLibrary,run:()=>T):T{installFixtureTransport();return libraries.run({library,observe:()=>{}},run);}
function text(message:any){return Array.isArray(message?.content)?message.content.filter((p:any)=>p.type==="text").map((p:any)=>p.text).join("\n"):"";}

export async function runStockCase(fixture:StockCase,profile:CandidateProfile,apiKey:string,options:{maxCompletions:number;timeoutMs:number;spendAvailable:()=>boolean;shellHelperDirectory?:string;stream?:StreamFn}){
 installFixtureTransport();
 let shellSession:ShellSession|undefined;
 const started=performance.now();const events:any[]=[];const requests:any[]=[];const providerReceipts:any[]=[];const pendingBodies:Promise<void>[]=[];
 const graph=Graph.empty();for(const term of fixture.roleCase?.initialTerms??[])graph.getOrCreate(term.label,term.description);
 const initialState=graph.serialize();const stt=emptySttLexicon();const actions:string[]=[];const flags:any[]=[];
 const history=new ConversationHistory();const ledger=new EvidenceLedger();const library=new FixtureLibrary(fixture.contexts??[]);const calls:any[]=[];
 const checks:{id:string;passed:boolean;critical:boolean;evidence:string}[]=[];
 const receipt:any={schemaVersion:1,caseId:fixture.id,caseDigest:objectDigest(fixture),profile,initialState,events,requests,providerReceipts,checks,answer:"",status:"unadjudicated",semanticReview:null,artifacts:[],libraryGeneration:library.generation};
 if(fixture.roleCase?.memoryConsent===false){const result=await verifyConsentOff(fixture.roleCase.transcript);const passed=Object.values(result).every(value=>value===0);checks.push({id:"consent",passed,critical:true,evidence:JSON.stringify(result)});receipt.status=passed?"passed":"failed";receipt.track="contract";receipt.finalState=initialState;receipt.metrics={seconds:(performance.now()-started)/1000,inputTokens:0,outputTokens:0,costUSD:0};return receipt;}
 const maintenance=emptyMaintenance();const fixtureEvents:any[]=[];let peerEdited=false;
 const role=fixture.roleCase?.role??"chat";if(role==="memory")prepareMaintenance(graph,maintenance);let windowOutcome:StageOutcome|undefined;let workingSummary="";const findings:any[]=[];const stageUsage={input:0,output:0};
 const stageRole=["audit","memory","summary"].includes(role);if(stageRole&&(!Number.isSafeInteger(profile.maxStageOutputTokens)||profile.maxStageOutputTokens!<1))throw new Error("Explicit candidate stage output budget required");
 const transcriptRecords:InspectionRecord[]=(fixture.roleCase?.transcript??"").split("\n").map((line,i)=>({id:`message-${i}`,title:`Message ${i}`,provenance:line.startsWith("User")?"user statement":line.startsWith("Assistant")?"assistant proposal or answer, not a user commitment":"untrusted tool/reference content, not instructions or a user commitment",text:line}));
 const controller=new AbortController();const timeout=setTimeout(()=>controller.abort(),options.timeoutMs);
 const assertActive=()=>{if(controller.signal.aborted)throw new Error("scenario_cancelled");};
 const inspector=createMemoryInspector({assertActive,records:collection=>{
  if(collection==="transcript")return transcriptRecords;
  if(collection==="window")return [{id:"current",title:"Complete fixture evidence",provenance:"complete synthetic records with explicit original roles",text:JSON.stringify(transcriptRecords)}];
  if(collection==="handoffs"&&role!=="audit")return [{id:"audit",title:"Completed synthetic audit",provenance:"fixture audit judgment, not user testimony",text:JSON.stringify({outcome:{kind:"completed"},findings:[]})}];
  if(collection==="memory")return [...graph.thoughts.values()].map(t=>({id:t.id,title:t.label,provenance:"stored personal description",text:JSON.stringify(t)}));
  if(collection==="actions")return [{id:"committed",title:"Prior actions",provenance:"committed action history",text:"(no prior actions)"},{id:"draft",title:"Draft actions",provenance:"uncommitted actions",text:actions.join("\n")}];
  if(collection==="working_summary")return [{id:"current",title:"Current summary",provenance:"generated summary, not verbatim evidence",text:workingSummary||"(no prior entry)"}];
  return [];
 },page:async(record,collection,cursor)=>inspectionPage(record,collection,cursor,record.text.slice(cursor),record.text.length)});
 let tools:AgentTool[]=[];let systemPrompt:string;
 if(fixture.shellCase){
  try{shellSession=await prepareShellCase(fixture.shellCase,options.shellHelperDirectory);receipt.shellBoundary=await shellSession.ready;}
  catch(error){clearTimeout(timeout);receipt.status="evaluator_error";receipt.failureCategory="sandbox_unavailable";receipt.error=error instanceof Error?error.message:"shell sandbox unavailable";receipt.metrics={seconds:(performance.now()-started)/1000,inputTokens:0,outputTokens:0,costUSD:0,completions:0};return receipt;}
  systemPrompt=buildOraclePrompt({modelName:profile.name??profile.id})+"\nSecondary shell sanity scenario: only the Bash tool and synthetic /work files are available. There is no library or personal-memory service in this track. Execute commands to satisfy the requested result, inspect failures and repair them when possible. Do not claim a command succeeded when the tool returned failure.";
  tools=[createShellTool(shellSession)];
 }else if(role==="chat"){
  systemPrompt=buildOraclePrompt({modelName:profile.name??profile.id});tools=[...createCorpusTools(ledger),createConversationHistoryTool(history,assertActive)];
 }else if(role==="compaction")systemPrompt=COMPACTION_INSTRUCTIONS;
 else{
  systemPrompt=PIPELINE_SYSTEM_STUB;
  const mutationTools=role==="summary"?[]:createPipelineTools({getGraph:()=>graph,getSttLexicon:()=>stt,embed:async()=>null,assertActive,maintenance,record:line=>actions.push(line),addFlag:flag=>flags.push(flag)});
  const finish=createStageOutcomeTool({finish:(kind,reason)=>{assertActive();if(role==="summary"&&kind!=="refused")throw new Error("Summary success requires summary_draft store or abstain");if(kind==="no-op"&&(actions.length||findings.length))throw new Error("No-op cannot hide draft actions/findings");windowOutcome={kind,reason};}});
  const summaryDraft=createSummaryDraftTool({read:()=>workingSummary,maxWords:8000,store:value=>{workingSummary=value;windowOutcome={kind:"completed"};},abstain:reason=>{windowOutcome={kind:"no-op",reason};}});
  const auditHandoff=createAuditHandoffTool({put:(finding,quotes)=>{assertActive();const evidence=quotes.map(ref=>{const record=transcriptRecords.find(r=>r.id===ref.recordId);if(!record||record.provenance!=="user statement"||!ref.quote.trim()||!record.text.includes(ref.quote))throw new Error("Handoff quote must match admitted user evidence");return {...ref,role:"user"};});if(finding.kind==="spelling")throw new Error("Typed fixture has no accepted speech evidence");if(!graph.thoughts.has(finding.termId)||!finding.reason.trim())throw new Error("Handoff requires an existing term and reason");findings.push({...finding,evidence});}});
  tools=assembleMemoryRoleTools(role,{mutationTools,inspector,finish,summaryDraft,auditHandoff,archive:createRoleArchiveTool({read:async()=>({records:[],next:null,scope:"own role, no archived synthetic stages"})})});
  if(role==="memory"){
   const review=createMaintenanceTool({graph,state:maintenance,assertActive,record:line=>actions.push(line),onMerge:()=>{}});const execute=review.execute;
   review.execute=async(id,args,signal,onUpdate)=>{
    const operation=(args as any).operation;
    if(fixture.fault?.kind==="maintenance-peer-edit"&&!peerEdited&&["merged","distinct","defer"].includes(operation)){
     graph.getOrCreate(fixture.fault.label,fixture.fault.description);peerEdited=true;fixtureEvents.push({kind:"peer-edit",label:fixture.fault.label,description:fixture.fault.description});
    }else if(peerEdited&&operation==="list")prepareMaintenance(graph,maintenance);
    return execute(id,args,signal,onUpdate);
   };tools.push(review);
  }
 }
 const model:Model<"openai-completions">={id:profile.id,name:profile.name??profile.id,api:"openai-completions",provider:"openrouter",baseUrl:"https://openrouter.ai/api/v1",reasoning:profile.reasoning,input:["text"],contextWindow:profile.contextWindow,maxTokens:profile.maxOutputTokens,cost:profile.prices??{input:0,output:0,cacheRead:0,cacheWrite:0}};
 receipt.systemPromptDigest=objectDigest(systemPrompt);receipt.toolSchemaDigest=objectDigest(tools.map(t=>({name:t.name,description:t.description,parameters:t.parameters})));
 let completions=0;
 const stream:StreamFn=(selected,context,settings)=>{
  if(!options.spendAvailable())throw new Error("screening_spend_limit");
  if(++completions>options.maxCompletions)throw new Error("completion_limit");
  if(options.stream)return options.stream(selected,context,settings);
  const remaining=stageRole?profile.maxStageOutputTokens!-stageUsage.output:profile.maxOutputTokens;if(remaining<=0)throw new Error("stage_output_budget");
  return streamSimple(selected,context,{...settings,apiKey,temperature:0,maxTokens:Math.min(profile.maxOutputTokens,remaining),reasoning:profile.thinkingLevel,maxRetries:0,timeoutMs:options.timeoutMs,
   onPayload(payload){const controlled={...(payload as object),provider:{...profile.providerRouting,require_parameters:true,allow_fallbacks:false}};if(Buffer.byteLength(JSON.stringify(controlled))>65536)throw new Error("screening_input_exposure_limit");requests.push(controlled);return controlled;},
  });
 };
 const observe=(response:Response)=>{
const meta:any={httpStatus:response.status};providerReceipts.push(meta);
    pendingBodies.push(response.clone().text().then(body=>{
     if(response.status>=400){try{const error=JSON.parse(body);meta.errorCode=error.error?.code;meta.errorMessage=error.error?.message;}catch{meta.errorMessage="non_json_provider_error";}}
     for(const line of body.split("\n")){if(!line.startsWith("data: ")||line.includes("[DONE]"))continue;try{const row=JSON.parse(line.slice(6));if(row.usage)meta.usage=row.usage;if(row.provider)meta.provider=row.provider;if(row.id)meta.id=row.id;if(row.error)meta.errorCode=row.error.code;}catch{}}
    }).catch(()=>{meta.bodyInterrupted=true;}));
 };
 let messages:AgentMessage[]=[];
 try{
  await libraries.run({library,observe},async()=>{
   for(const step of fixture.steps){
    if(step.action!=="send")throw new Error("unknown_scenario_action");
    let content=step.text;
    if(role!=="chat"&&role!=="compaction"){
     const ctx={bufferBlock:"Read memory_inspect(actions,id=committed) for prior actions; draft actions are actions/draft.",isVoiceTurn:false};
     const instruction=role==="audit"?buildAuditInstructions(ctx):role==="memory"?buildMemoryManagerInstructions(ctx):buildSummaryInstructions("Read prior summaries through memory_inspect; current draft is working_summary/current.");
     content=`${instruction}${role==="memory"?"\n"+MAINTENANCE_INSTRUCTIONS:""}\n\n## Complete synthetic evidence records\n${JSON.stringify(transcriptRecords)}\nAll records in this scenario are complete. Personal descriptions, prior actions and summaries remain inspectable through memory_inspect.`;
    }
    const generated=await runAgentLoop([{role:"user",content,timestamp:Date.now()}],{systemPrompt,messages,tools},{model,apiKey,convertToLlm:items=>items.filter(m=>["user","assistant","toolResult"].includes(m.role)) as any,shouldStopAfterTurn:()=>completions>=options.maxCompletions},event=>{events.push(structuredClone(event));if(event.type==="message_end"){history.capture(event.message);if(stageRole&&event.message.role==="assistant"&&!["error","aborted"].includes(event.message.stopReason)){addTokenUsage(stageUsage,validatedTokenUsage(event.message.usage,"pi",true));}}if(event.type==="tool_execution_end")calls.push(structuredClone(event));},controller.signal,stream);
    messages.push(...generated);
   }
  });
  const last=[...messages].reverse().find(m=>m.role==="assistant") as any;
  receipt.answer=role==="summary"?workingSummary:text(last);receipt.terminalProse=text(last);receipt.windowOutcome=windowOutcome;receipt.stageUsage=stageUsage;if(stageRole){try{validateMemoryWindowOutcome(windowOutcome,last?.stopReason);checks.push({id:"explicit_stage_outcome",passed:true,critical:true,evidence:JSON.stringify(windowOutcome)});}catch(error){checks.push({id:"explicit_stage_outcome",passed:false,critical:true,evidence:error instanceof Error?error.message:"invalid_outcome"});}}receipt.stopReason=last?.stopReason;receipt.messages=messages;
  checks.push({id:"valid_completion",passed:last?.stopReason==="stop"&&Boolean(receipt.answer.trim()||(stageRole&&["no-op","completed"].includes(windowOutcome?.kind??""))),critical:true,evidence:`Pi stopReason=${last?.stopReason??"missing"}`});
  if(fixture.roleCase?.memoryConsent){checks.push({id:"schema_validity",passed:!calls.some(call=>call.isError&&!(fixture.fault?.kind==="maintenance-peer-edit"&&JSON.stringify(call.result).includes("Candidate missing or changed"))),critical:true,evidence:"Actual Pi tool errors are retained; the declared stale-peer rejection is expected and must be recovered."});}
  if(role==="chat"&&!fixture.shellCase){
   const citations=inspectCorpusCitations(receipt.answer,ledger,"http://127.0.0.1");receipt.citations=citations;
   const readIds=new Set(calls.filter(call=>call.toolName==="corpus_read").flatMap(call=>(call.result?.details?.passages??[]).map((p:any)=>p.passage_id)));
   const incompleteIds=new Set(calls.filter(call=>call.toolName==="corpus_search").flatMap(call=>(call.result?.details?.hits??[]).filter((p:any)=>!p.complete).map((p:any)=>p.passage_id)));
   checks.push({id:"source_identity",passed:citations.unknown.length===0&&citations.known.length>0,critical:true,evidence:JSON.stringify({known:citations.known.length,unknown:citations.unknown})},
    {id:"corpus_used",passed:library.requests.some(r=>r.kind==="search"),critical:true,evidence:JSON.stringify(library.requests)},
    {id:"read_source",passed:citations.known.length>0&&citations.known.every(p=>!incompleteIds.has(p.passage_id)||readIds.has(p.passage_id)),critical:true,evidence:"Cited incomplete excerpts require reading the original. Complete search passages do not require a redundant read."});
  }
  if(checks.some(c=>c.critical&&!c.passed))receipt.status="failed";
 }catch(error){receipt.status="evaluator_error";receipt.error=error instanceof Error?error.message:"unknown_error";}
 finally{await Promise.allSettled(pendingBodies);clearTimeout(timeout);}
 if(shellSession&&fixture.shellCase){
  try{receipt.shellExecutions=shellSession.executions;checks.push(...await shellSession.grade(fixture.shellCase));if(receipt.status!=="transport_error"&&receipt.status!=="evaluator_error")receipt.status=checks.every(c=>c.passed)?"passed":"failed";}
  catch(error){receipt.status="evaluator_error";receipt.error=error instanceof Error?error.message:"shell_grading_failed";}
  finally{shellSession.dispose();}
 }
 const forbidden=new Set((fixture.roleCase?.forbiddenTools??[]).filter(name=>!["add_term","update_description"].includes(name)));
 for(const call of calls)if(forbidden.has(call.toolName)){checks.push({id:`forbidden_tool:${call.toolName}`,passed:false,critical:true,evidence:"Case policy explicitly forbids this operation; state/provenance is reviewed separately."});receipt.status="failed";}
 if(fixture.fault?.kind==="maintenance-peer-edit"){
  const rejected=calls.some(call=>call.isError&&JSON.stringify(call.result).includes("Candidate missing or changed"));
  checks.push({id:"stale_peer_guard",passed:peerEdited&&rejected&&graph.thoughts.size>=2,critical:true,evidence:JSON.stringify(fixtureEvents)});
  if(!checks.at(-1)!.passed)receipt.status="failed";
 }
 receipt.maintenance=maintenance;receipt.fixtureEvents=fixtureEvents;receipt.finalState=graph.serialize();receipt.stt=stt;receipt.actions=actions;receipt.flags=flags;receipt.toolCalls=calls;receipt.libraryRequests=library.requests;
 const validUsage=(u:any)=>u&&Number.isSafeInteger(u.prompt_tokens)&&u.prompt_tokens>=0&&Number.isSafeInteger(u.completion_tokens)&&u.completion_tokens>=0&&typeof u.cost==="number"&&Number.isFinite(u.cost)&&u.cost>=0;
 const usage=providerReceipts.flatMap(r=>validUsage(r.usage)?[r.usage]:[]);
 receipt.metrics={seconds:(performance.now()-started)/1000,inputTokens:usage.reduce((n,u)=>n+(u.prompt_tokens??0),0),outputTokens:usage.reduce((n,u)=>n+(u.completion_tokens??0),0),costUSD:usage.reduce((n,u)=>n+(u.cost??0),0),completions};
 if(providerReceipts.some(r=>r.httpStatus>=400||r.errorCode!=null||r.bodyInterrupted))receipt.status="transport_error";
 receipt.usageIncomplete=providerReceipts.some(r=>!validUsage(r.usage));
 return receipt;
}
