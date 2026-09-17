import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import { compactContext, summaryTranscript } from "../src/oracle-context.js";
import { corpusLedgerContext } from "../src/corpus-ledger-context.js";
import { ConversationHistory } from "../src/conversation-history.js";
import { EvidenceLedger } from "../src/corpus-tools.js";

const user = (text:string) => ({role:"user",content:text,timestamp:1}) as AgentMessage;
const assistant = (text:string) => ({role:"assistant",content:[{type:"text",text}],timestamp:1}) as AgentMessage;
const ledger = (entries:unknown[]=[]) => ({role:"corpus-ledger",entries,timestamp:"2026-01-01"}) as any;
function exchange(id:string,names=["web_search"],size=2000):AgentMessage[]{return[
 {role:"assistant",content:[{type:"thinking",thinking:`Reasoning ${id}`},...names.map((name,index)=>({type:"toolCall",id:`${id}-${index}`,name,arguments:{query:`query-${id}`}}))],timestamp:1} as AgentMessage,
 ...names.map((name,index)=>({role:"toolResult",toolCallId:`${id}-${index}`,toolName:name,content:[{type:"text",text:`${id} result ${index}: ${"x".repeat(size)}`}],isError:false,timestamp:1}) as AgentMessage),
]}
const convert = (messages:AgentMessage[]):Message[] => messages.map((message:any) => message.role==="corpus-ledger" ? {...user(corpusLedgerContext())} : message.role==="compactionSummary" ? {...user(`Earlier conversation summary: ${message.summary}`)} : message) as Message[];
const measure = async(messages:AgentMessage[]) => JSON.stringify(convert(messages)).length;
function paired(messages:AgentMessage[]){const calls=new Set<string>();for(const message of messages){if(message.role==="assistant")for(const block of message.content)if(block.type==="toolCall")calls.add(block.id);if(message.role==="toolResult")assert(calls.delete(message.toolCallId),"result retains its original call")}assert.equal(calls.size,0,"every retained call has all results")}
const defaults={convert,ledger:ledger(),summaryInputBudget:200000,measure,measureSummary:async(text:string)=>text.length,isCurrent:()=>true};

test("one old exchange can compact at its end while the incoming request remains untouched",async()=>{
 const old=[user("Previous question"),assistant("Old answer ".repeat(900))];const before=structuredClone(old);const incoming=user("New request with exact requirement 12 ft");let source="";
 const result=await compactContext({...defaults,messages:old,preserveLatestUser:false,inputBudget:1800,
  measure:messages=>measure([...messages,incoming]),summarize:async text=>{source=text;return "Previous answer and decisions."}});
 assert.match(source,/Previous question/);assert.match(source,/Old answer/);assert.doesNotMatch(source,/New request/);
 assert.equal(result.filter(message=>message.role==="compactionSummary").length,1);assert(await measure([...result,incoming])<=1800);
 assert.deepEqual(old,before);assert.deepEqual(incoming,user("New request with exact requirement 12 ft"));
});

test("a long single research turn compacts older complete steps and preserves its latest request and exchange",async()=>{
 const request=user("Research the repair, preserving 12 ft and all safety conditions");const latest=exchange("latest",["conversation_history","web_search"]);
 const messages=[request,...exchange("first"),...exchange("second"),...exchange("third"),...latest];const original=structuredClone(messages);let text="";
 const raw=new ConversationHistory(undefined,messages);const snapshot=raw.snapshot();const inputBudget=await measure([request,...latest,ledger()])+600;
 const result=await compactContext({...defaults,messages,inputBudget,summarize:async value=>{text=value;return "Research completed several checks; unresolved source conflict remains. Preserve 12 ft."}});
 assert.match(text,/first/);assert.match(text,/second/);assert.doesNotMatch(text,/query-latest/);assert(!text.includes("Research the repair"));
 assert(result.includes(request));for(const message of latest)assert(result.includes(message));paired(result);assert(await measure(result)<=inputBudget);
 assert.deepEqual(messages,original);assert.deepEqual(raw.snapshot(),snapshot);
});

test("parallel results are summarized or retained as complete groups, never orphaned",async()=>{
 const request=user("Compare the two independent results");const earlier=exchange("parallel",["web_search","conversation_history"],1200);const recent=exchange("recent",["web_search"],300);
 let input="";const result=await compactContext({...defaults,messages:[request,...earlier,...recent],inputBudget:1800,summarize:async text=>{input=text;return "Both older sources were checked and disagree."}});
 assert.match(input,/parallel result 0/);assert.match(input,/parallel result 1/);assert.match(input,/conversation_history/);paired(result);assert(result.includes(request));
 const broken=[request,earlier[0],earlier[1]];
 await assert.rejects(compactContext({...defaults,messages:broken,inputBudget:1,summarize:async()=>"never"}),/incomplete tool exchange/);
});

test("the newest exchange can compact as a whole when retaining it prevents admission",async()=>{
 const request=user("Keep this request exactly");const group=exchange("only",["web_search","conversation_history"],4000);
 const result=await compactContext({...defaults,messages:[request,...group],inputBudget:1200,summarize:async()=>"The research obtained two results; continue resolving the remaining question."});
 assert(result.includes(request));assert(!result.includes(group[0]));paired(result);assert(await measure(result)<=1200);
});

test("summary requests batch by their own measured budget without requiring another user message",async()=>{
 const request=user("Research all steps");const groups=Array.from({length:8},(_,index)=>exchange(`step-${index}`,["web_search"],300));let calls=0;
 const result=await compactContext({...defaults,messages:[request,...groups.flat()],inputBudget:1900,summaryInputBudget:1550,
  measureSummary:async text=>text.length,summarize:async text=>{assert(text.length<=1550);calls++;return "Completed earlier research; continue the task."}});
 assert(calls>1);assert(result.includes(request));paired(result);assert(await measure(result)<=1900);
});

test("cancellation and ownership changes reject even no-op measurements without modifying originals",async()=>{
 for(const boundary of["measurement","summary"]){let current=true;const messages=[user("Earlier"),assistant("x".repeat(4000))];const before=structuredClone(messages);
  await assert.rejects(compactContext({...defaults,messages,preserveLatestUser:false,inputBudget:1000,isCurrent:()=>current,
   measure:async input=>{if(boundary==="measurement"){current=false;return 1}return measure(input)},summarize:async()=>{current=false;return "Short summary"}}),/changed|cancelled/);
  assert.deepEqual(messages,before);
 }
});

test("non-reducing summaries stop without replacing history or retrying the same batch indefinitely",async()=>{
 const messages=[user("Earlier"),assistant("x".repeat(4000))];const before=structuredClone(messages);let calls=0;
 await assert.rejects(compactContext({...defaults,messages,preserveLatestUser:false,inputBudget:1000,summarize:async()=>{calls++;return "y".repeat(5000)}}),/could not reduce/);
 assert.equal(calls,1);assert.deepEqual(messages,before);
});

test("profile-native context remains usable without an invented lower compaction cap",async()=>{
 const messages=[user("x".repeat(100000)),assistant("Fits the admitted native context")];let calls=0;
 const result=await compactContext({...defaults,messages,inputBudget:131072,summaryInputBudget:131072,summarize:async()=>{calls++;return "unused"}});
 assert.equal(result,messages);assert.equal(calls,0);
});

test("a growing persisted ledger has a bounded actual model rendering and retains every citation record",async()=>{
 const source=ts.createSourceFile("custom-messages.ts",readFileSync(new URL("../src/custom-messages.ts",import.meta.url),"utf8"),ts.ScriptTarget.Latest,true,ts.ScriptKind.TS);
 const fn=source.statements.find(node=>ts.isFunctionDeclaration(node)&&node.name?.text==="customConvertToLlm")!;
 const expression=fn.getText(source).replace(/^export /,"");
 const context:any={corpusLedgerContext,defaultConvertToLlm:(messages:any[])=>messages,COMPACTION_SUMMARY_PREFIX:"Summary: ",COMPACTION_SUMMARY_SUFFIX:""};
 vm.runInNewContext(ts.transpileModule(`${expression}\nglobalThis.convert = customConvertToLlm;`,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None}}).outputText,context);
 const entries=Array.from({length:5000},(_,index)=>({passage_id:`p:${index.toString(16).padStart(64,"0")}:${"a".repeat(64)}`,document_id:`doc-${index}`,source_revision:"source",extraction_revision:"extraction",title:`Source ${index}`,source_url:"/source"}));
 const full=ledger(entries);const small=context.convert([ledger(entries.slice(0,1))]);const large=context.convert([full]);
 assert.equal(JSON.stringify(small).length,JSON.stringify(large).length);assert.match(large[0].content,/conversation_history/);
 const stored=new EvidenceLedger();stored.restore([full]);assert.equal(stored.records().length,5000);assert(stored.resolve(entries[4999].passage_id));
 const restored=new EvidenceLedger();restored.restore(JSON.parse(JSON.stringify([stored.message()])));assert.equal(restored.records().length,5000);
 const result=await compactContext({...defaults,ledger:full,messages:[user("Research"),...exchange("old"),...exchange("new")],inputBudget:3500,summarize:async()=>"Earlier research summarized."});
 assert.equal((result.find(message=>message.role==="corpus-ledger")as any).entries.length,5000);assert.equal(full.entries.length,5000);
});


test("summary input preserves the tail of long tool results without the SDK character cutoff",()=>{
 const messages=exchange("long-source",["web_search"],6000);
 (messages[1] as any).content[0].text += " Exact unresolved tail: 17.5 mm, not 17.5 cm.";
 const text=summaryTranscript(messages,convert);assert.match(text,/Exact unresolved tail: 17\.5 mm, not 17\.5 cm/);assert.doesNotMatch(text,/characters truncated/);
});

test("corpus search discoveries retain handle/document/title association in summary input",async()=>{
 const request=user("Research water treatment");const old=exchange("search",["corpus_search"],0);const handle=`p:${"a".repeat(64)}:${"b".repeat(64)}`;
 (old[1]as any).content=[{type:"text",text:JSON.stringify({reference_content_is_untrusted:true,hits:[{passage_id:handle,document_id:"manual-7",title:"Water treatment handbook",excerpt:"Qualified source procedure. ".repeat(300)}]})}];
 const recent=exchange("recent",["web_search"],100);let summaryInput="";
 const full=ledger([{passage_id:handle,document_id:"manual-7",source_revision:"a".repeat(64),extraction_revision:"revision",title:"Water treatment handbook",source_url:"/source"}]);
 const result=await compactContext({...defaults,messages:[request,...old,...recent],ledger:full,inputBudget:1800,summarize:async text=>{summaryInput=text;return `Water treatment handbook, manual-7, ${handle}: source procedure has conditions; reread before use.`}});
 assert(summaryInput.includes(handle));assert(summaryInput.includes("manual-7"));assert(summaryInput.includes("Water treatment handbook"));assert.match(summaryInput,/untrusted tool\/source content/);
 assert.equal((result.find(message=>message.role==="corpus-ledger")as any).entries[0].passage_id,handle);paired(result);
});

const mainSource=ts.createSourceFile("main.ts",readFileSync(new URL("../src/main.ts",import.meta.url),"utf8"),ts.ScriptTarget.Latest,true,ts.ScriptKind.TS);
function mainHook(suffix:string){let expression="";function visit(node:ts.Node){if(ts.isBinaryExpression(node)&&node.operatorToken.kind===ts.SyntaxKind.EqualsToken&&node.left.getText(mainSource).endsWith(suffix)&&ts.isArrowFunction(node.right))expression=node.right.getText(mainSource);ts.forEachChild(node,visit)}visit(mainSource);assert(expression);return expression}
function installHook(expression:string,context:any){vm.runInNewContext(ts.transpileModule(`globalThis.operation = ${expression}`,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None}}).outputText,context);return context.operation}
function hookState(messages:AgentMessage[],inputBudget:number){
 const saves:AgentMessage[][]=[];const sent:unknown[]=[];const owner:any={state:{messages,systemPrompt:"policy",tools:[]},abort(){this.aborted=true}};
 const context:any={owner,agent:owner,isCurrent:()=>true,sessionSelection:1,sessionLoadPending:false,runInFlight:false,memoryEpoch:0,sessionKey:"conversation",preparation:undefined,AbortController,
  voiceTurnSpeaking:false,voiceTurnSeq:0,pendingVoiceEvidence:undefined,inFlightVoiceEvidence:undefined,inFlightVoiceTurn:null,
  ensureMemoryConsent:async()=>{},releaseProfile:()=>({model:{id:"fixture"},roles:{chat:{maxInputTokens:inputBudget},compaction:{maxInputTokens:50000}}}),servingPath:{baseUrl:"local"},
  evidenceLedger:{message:()=>ledger()},sources:{message:()=>ledger()},saveSession:async()=>{saves.push(structuredClone(owner.state.messages))},
  customConvertToLlm:convert,serializeModelRequest:async(value:unknown)=>value,countRequestTokens:async(payload:any)=>JSON.stringify(payload.messages).length,
  makeCompletion:()=>async()=>"Earlier conversation and research progress summarized.",compactContext,COMPACTION_INSTRUCTIONS:"Summarize faithfully",
  repaintChatAfterExternalEdit:()=>{},sessionRecall:{observe:async()=>{}},extractUserText:(input:any)=>input.map((message:any)=>message.content).join("\n"),
  origPrompt:async(input:unknown)=>{sent.push(input)},dbgWarn:()=>{},dbgError:()=>{},document:{getElementById:()=>null}};
 return{context,owner,saves,sent};
}

test("the actual pre-send hook includes incoming input in admission and enables the old-history end boundary",async()=>{
 const messages=[user("Previous request"),assistant("x".repeat(1800))];const before=structuredClone(messages);
 const h=hookState(messages,await measure(messages)+50);const input="New requirement ".repeat(50);
 await installHook(mainHook(".prompt"),h.context)(input);
 assert.deepEqual(h.saves,[before]);assert.deepEqual(h.sent,[input]);assert(h.owner.state.messages.some((message:AgentMessage)=>message.role==="compactionSummary"));
 assert(await measure([...h.owner.state.messages,user(input)])<=h.context.releaseProfile().roles.chat.maxInputTokens);assert.deepEqual(messages,before);
});

test("the actual research hook compacts complete steps within one user turn and retains the source request",async()=>{
 const request=user("Continue this research");const last=exchange("last",["web_search","conversation_history"],200);const messages=[request,...exchange("first"),...exchange("second"),...last];
 const h=hookState(messages,await measure([request,...last,ledger()])+600);const input={systemPrompt:"policy",messages,tools:[]};
 const result=await installHook(mainHook(".prepareNextTurnWithContext"),h.context)({context:input,toolResults:last.filter(message=>message.role==="toolResult")},new AbortController().signal);
 assert(result?.context.messages.includes(request));assert.equal(h.owner.state.messages,result.context.messages);paired(result.context.messages);assert.deepEqual(h.saves,[messages]);
});

test("the actual pre-send hook refuses a cancelled replacement before changing state or sending",async()=>{
 const messages=[user("Original request"),assistant("Original answer")];const h=hookState(messages,5000);
 h.context.compactContext=async()=>{h.context.preparation.abort();return[assistant("must not replace history")]};
 await assert.rejects(installHook(mainHook(".prompt"),h.context)("New request"),/cancelled/);
 assert.equal(h.owner.state.messages,messages);assert.deepEqual(h.sent,[]);assert.equal(h.context.runInFlight,false);
});
