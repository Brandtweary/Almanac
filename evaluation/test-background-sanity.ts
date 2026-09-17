import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createAssistantMessageEventStream} from '@earendil-works/pi-ai';
import {runStockCase} from './stock.ts';
import {loadStockCases,objectDigest} from './stock-cases.ts';
import {loadBackgroundSanityCases,loadCorrectedBackgroundSanityCases,loadBackgroundSanityV3Cases} from './background-sanity.ts';
import {englishWords,validateAutoReplace} from '../src/stt-lexicon.ts';
const profile={id:'fixture',contextWindow:32768,maxOutputTokens:2048,maxStageOutputTokens:16384,reasoning:false};
async function run(index:number,plan:Array<[string,any]>,corrected:boolean|3=false) {
 let step=0;
 return runStockCase((corrected===3?loadBackgroundSanityV3Cases():corrected?loadCorrectedBackgroundSanityCases():loadBackgroundSanityCases())[index],profile,'unused',{maxCompletions:20,timeoutMs:10000,spendAvailable:()=>true,stream:()=>{
  const event=createAssistantMessageEventStream(),call=plan[step++],stopReason=call?'toolUse':'stop';
  const message:any={role:'assistant',content:call?[{type:'toolCall',id:`call-${step}`,name:call[0],arguments:call[1]}]:[{type:'text',text:'Complete.'}],api:'openai-completions',provider:'fixture',model:'fixture',usage:{input:1,output:1,cacheRead:0,cacheWrite:0,totalTokens:2,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},stopReason,timestamp:Date.now()};
  queueMicrotask(()=>{event.push({type:'done',reason:stopReason as any,message});event.end(message)});return event;
 }});
}
test('supplemental cases leave canonical stock inventory unchanged and use real dictionary',async()=>{
 const before=objectDigest(loadStockCases());assert.equal(loadStockCases().length,49);assert.equal(loadBackgroundSanityCases().length,3);assert.equal(objectDigest(loadStockCases()),before);
 assert((await englishWords()).has('storm'));await assert.rejects(validateAutoReplace('storm','different'),/real English word/);await validateAutoReplace('snocking','snacking');
});
test('positive raw evidence, rule and exact handoff execute actual production tools',async()=>{
 const r=await run(0,[['memory_inspect',{collection:'voice',id:'raw'}],['phonetic_candidates',{}],['log_mistranscription',{spoken:'snacking',transcribed:'snocking',kind:'phonetic'}],['add_auto_replace_rule',{from:'snocking',to:'snacking'}],['audit_handoff',{kind:'spelling',spoken:'snacking',transcribed:'snocking',utteranceId:'synthetic-voice-1',evidence:[{recordId:'message-0',quote:'snacking'}]}],['memory_finish',{outcome:'completed',reason:'Supported spelling correction'}]]);
 assert(r.checks.every((c:any)=>c.passed),JSON.stringify(r.toolCalls));assert.equal(r.stt.autoReplace[0].to,'snacking');assert.equal(r.auditFindings[0].utteranceId,'synthetic-voice-1');assert.equal(r.stt.mistranscriptions[0].rawText,loadBackgroundSanityCases()[0].backgroundSeed!.voice!.rawText);
});
test('unsupported spelling handoff cannot bypass accepted current-utterance evidence',async()=>{
 const r=await run(0,[['audit_handoff',{kind:'spelling',spoken:'snacking',transcribed:'snocking',utteranceId:'synthetic-voice-1',evidence:[{recordId:'message-0',quote:'snacking'}]}],['memory_finish',{outcome:'no-op',reason:'No supported correction'}]]);
 assert.equal(r.auditFindings.length,0);assert(r.toolCalls[0].isError);assert.match(JSON.stringify(r.toolCalls[0]),/accepted current-utterance/);
});
test('rejecting a seeded bad rule preserves rejected evidence and intentional alias',async()=>{
 const r=await run(1,[['inspect_stt',{transcribed:'salvation'}],['reject_mistranscription',{transcribed:'salvation',spoken:'sub-agent'}],['memory_finish',{outcome:'completed',reason:'Intentional title preserved'}]]);
 assert(r.checks.every((c:any)=>c.passed),JSON.stringify(r.checks));assert.equal(r.stt.autoReplace.length,0);assert.equal(r.stt.mistranscriptions[0].status,'rejected');assert.deepEqual(Object.values(r.finalState.thoughts).map((t:any)=>t.aliases),[['Rescue']]);
});
test('prior-action recurrence and aliases survive fixture assembly without invented actions',async()=>{
 const r=await run(2,[['memory_inspect',{collection:'actions',id:'committed'}],['rename_term',{from:'glaze-shelve',to:'glaze-shelf'}],['memory_finish',{outcome:'completed',reason:'Repeated typo repaired'}]]);
 assert.match(JSON.stringify(r.toolCalls[0]),/Independent second user turn/);
 assert(r.checks.every((c:any)=>c.passed),JSON.stringify(r.checks));
 const before=Object.values(r.initialState.thoughts).find((t:any)=>t.label==='glaze-shelve') as any;
 const after=Object.values(r.finalState.thoughts).find((t:any)=>t.label==='glaze-shelf') as any;
 assert.equal(after.id,before.id);assert.deepEqual(after.aliases,['kiln','drying rack']);
});

test('corrected fixtures contain actual routed admitted memory with distinct provenance',async()=>{
 for(const index of [0,1]){
  const r=await run(index,[['memory_inspect',{collection:'transcript',id:'retrieval-0'}],['memory_finish',{outcome:'no-op',reason:'Mechanical fixture probe'}]],true);
  assert.deepEqual(r.syntheticRetrieval.delivery.terms.map((t:any)=>t.label).sort(),loadCorrectedBackgroundSanityCases()[index].backgroundSeed!.retrieval!.expectedLabels.sort());
  assert.match(r.toolCalls[0].result.content[0].text,/<memory>/);assert.match(r.toolCalls[0].result.content[0].text,/retrieved personal memory, not a new user statement/);
  assert.equal(r.syntheticRetrieval.delivery.status,'admitted');assert(r.checks.every((c:any)=>c.passed));
 }
 assert.equal((await englishWords()).has('snocking'),false);assert.equal((await englishWords()).has('snacking'),true);
});
test('retrieval text cannot be laundered into a user handoff quote',async()=>{
 const r=await run(0,[['audit_handoff',{kind:'stale-description',termId:'nonempty',reason:'Changed day',evidence:[{recordId:'retrieval-0',quote:'Fridays'}]}],['memory_finish',{outcome:'no-op',reason:'No supported finding'}]],true);
 assert(r.toolCalls[0].isError);assert.match(r.toolCalls[0].result.content[0].text,/admitted user evidence/);assert.equal(r.auditFindings.length,0);
});
test('missing conditional handoff fields have shared explicit errors and cannot publish',async()=>{
 const {createAuditHandoffTool}=await import('../src/memory-handoffs.ts');let published=0;const tool=createAuditHandoffTool({put:()=>{published++}});
 assert.match(tool.description,/nonempty reason/);assert.match(tool.description,/transcribed, spoken and utteranceId/);
 await assert.rejects(tool.execute('bad',{kind:'stale-description',termId:'term',evidence:[{recordId:'message-0',quote:'Tuesdays'}]},undefined,undefined),/existing term and reason/);
 await assert.rejects(tool.execute('bad',{kind:'spelling',spoken:'snacking',evidence:[{recordId:'message-0',quote:'snacking'}]},undefined,undefined),/transcribed, spoken and utteranceId/);
 assert.equal(published,0);
 const r=await run(0,[['audit_handoff',{kind:'stale-description',termId:'term',evidence:[{recordId:'message-0',quote:'Tuesdays'}]}],['memory_finish',{outcome:'no-op',reason:'No supported finding'}]],true);
 assert.match(r.toolCalls[0].result.content[0].text,/existing term and reason/);assert.doesNotMatch(r.toolCalls[0].result.content[0].text,/undefined|trim/);
});

test('typed explicit historical rejection cleans stored rules without new voice evidence',async()=>{
 const {buildAuditInstructions}=await import('../src/pipeline-prompts.ts');const prompt=buildAuditInstructions({isVoiceTurn:false,bufferBlock:''});
 assert.doesNotMatch(prompt,/Skip every speech-to-text/);assert.match(prompt,/Do not treat it as voice evidence/);assert.match(prompt,/Historical cleanup does not authorize new logs, pronunciation hints or automatic rules from typed prose/);
 const r=await run(1,[['inspect_stt',{transcribed:'salvation'}],['reject_mistranscription',{transcribed:'salvation',spoken:'sub-agent'}],['memory_finish',{outcome:'completed',reason:'Explicit mistaken stored pairing rejected'}]],3);
 assert(r.checks.every((c:any)=>c.passed));assert.equal(r.stt.autoReplace.length,0);assert.equal(r.stt.mistranscriptions.length,1);assert.equal(r.stt.mistranscriptions[0].utteranceId,'synthetic-old-voice');assert.equal(r.stt.mistranscriptions[0].status,'rejected');
 const unsupported=await run(1,[['log_mistranscription',{transcribed:'salvation',spoken:'sub-agent',kind:'phonetic'}],['memory_finish',{outcome:'no-op',reason:'No current voice evidence'}]],3);
 assert(unsupported.toolCalls[0].isError);assert.equal(unsupported.stt.mistranscriptions.length,1);
});
test('Porter toggle fixes opt-in stemming but cannot claim an arms/arm repair',async()=>{
 const {Graph}=await import('../src/kg/graph.ts');const {createPipelineTools}=await import('../src/pipeline-tools.ts');const graph=Graph.empty();graph.getOrCreate('running','A running activity.');graph.setNoStem('running',false);graph.getOrCreate('arms','A strength-training log.');
 const tools=createPipelineTools({getGraph:()=>graph,getSttLexicon:()=>({mistranscriptions:[],autoReplace:[]}),embed:async()=>null,record:()=>{},addFlag:()=>{}});const toggle=tools.find(t=>t.name==='set_no_stem')!;
 const labels=(text:string)=>graph.termMatch(text).map(t=>t.label);assert.deepEqual(labels('run'),['running']);await toggle.execute('toggle',{label:'running',no_stem:true},undefined,undefined);assert.deepEqual(labels('run'),[]);assert.deepEqual(labels('running'),['running']);
 assert.deepEqual(labels('arm'),['arms']);const result=await toggle.execute('toggle',{label:'arms',no_stem:true},undefined,undefined);assert.deepEqual(labels('arm'),['arms']);assert.match(JSON.stringify(result),/plural and punctuation normalization remain/);assert.doesNotMatch(JSON.stringify(result),/exactly/);
 const r=await run(2,[['set_no_stem',{label:'arms',no_stem:true}],['flag_for_review',{kind:'needs-surgery',label:'arms',description:'Plural normalization still retrieves Arms for arm; available toggle cannot fix this while preserving the name.'}],['memory_finish',{outcome:'completed',reason:'Unsupported collision flagged, not repaired'}]],3);
 assert(r.checks.every((c:any)=>c.passed),JSON.stringify(r.toolCalls));assert.deepEqual(r.matchingBefore.arm,['arms']);assert.deepEqual(r.matchingAfter.arm,['arms']);assert.equal(r.flags[0].kind,'needs-surgery');
});
