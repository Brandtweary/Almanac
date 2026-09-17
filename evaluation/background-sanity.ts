/** Supplemental development cases; the canonical stock case inventory stays unchanged. */
import {readFileSync} from 'node:fs';
import type {StockCase} from './stock-cases.ts';
import type {SttLexicon,VoiceEvidence} from '../src/stt-lexicon.ts';
import type {PhonemizeResult} from '../src/stt-phonemize.ts';
export interface BackgroundSeed {
 voice?:VoiceEvidence;
 stt?:SttLexicon;
 priorAudit?:Array<{ts:string;actions:string[];note:string}>;
 summary?:string;
 retrieval?:{messageText:string;expectedLabels:string[]};
 matchingProbes?:string[];
 pronunciation?:{engine:PhonemizeResult['engine'];entries:Record<string,string>;scope:string};
}
export function loadBackgroundSanityCases():StockCase[]{
 const fixture=JSON.parse(readFileSync(new URL('./background-sanity-cases.json',import.meta.url),'utf8'));
 return fixture.cases.map((c:any)=>{
  if(!/^[a-z0-9-]+$/.test(c.id)||!c.text||!c.rubric?.length||!Array.isArray(c.terms))throw Error('Invalid background sanity fixture');
  const {voice,stt,priorAudit,summary,pronunciation}=c;
  if(voice&&voice.correctedText!==c.text)throw Error('Voice display differs from admitted statement');
  const rubric=c.rubric.filter((r:string)=>!r.startsWith('Summary ')&&!r.startsWith('Publish useful ')).map((r:string)=>r.startsWith('Correct workshop meeting day')?'Identify Friday as stale and Tuesday as current, either by correcting the description while preserving oat bars or by an exact-source stale-description handoff to memory.':r);
  if(voice)rubric.push('Publish a supported spelling handoff with exact admitted user quote; stale-description handoff is appropriate when audit leaves the update for memory. Downstream consumption is outside this isolated role case.');
  return {id:`background.${c.id}`,split:'development',track:'agent',family:'audit',description:rubric.join(' '),steps:[{action:'send',text:`User: ${c.text}`}],roleCase:{id:c.id,split:'development',role:'audit',transcript:`User: ${c.text}`,memoryConsent:true,initialTerms:c.terms,forbiddenTools:voice?[]:['log_mistranscription','correct_mistranscription'],rubric},backgroundSeed:{voice,stt,priorAudit,summary,pronunciation},assertions:[{id:'valid_completion',kind:'completion',critical:true},{id:'schema_validity',kind:'tool_schema',critical:true}],rubric};
 });
}

/** Versioned repair; original fixture loader and frozen receipts remain unchanged. */
export function loadCorrectedBackgroundSanityCases():StockCase[]{
 const suite=JSON.parse(readFileSync(new URL('./background-sanity-v2-cases.json',import.meta.url),'utf8'));
 if(suite.schemaVersion!==2||suite.cases.length!==2)throw Error('Unexpected corrected background suite');
 return suite.cases.map((c:any)=>({id:`background.${c.id}`,split:'development',track:'agent',family:'audit',description:c.rubric.join(' '),steps:[{action:'send',text:`User: ${c.text}`}],roleCase:{id:c.id,split:'development',role:'audit',transcript:`User: ${c.text}`,memoryConsent:true,initialTerms:c.terms,forbiddenTools:c.voice?[]:['log_mistranscription','correct_mistranscription'],rubric:c.rubric},backgroundSeed:{voice:c.voice,stt:c.stt,priorAudit:c.priorAudit,summary:c.summary,pronunciation:c.pronunciation,retrieval:c.retrieval},assertions:[{id:'valid_completion',kind:'completion',critical:true},{id:'schema_validity',kind:'tool_schema',critical:true}],rubric:c.rubric}));
}

/** Corrected cleanup/matching contract; v1 and v2 identities remain independently available. */
export function loadBackgroundSanityV3Cases():StockCase[]{
 const suite=JSON.parse(readFileSync(new URL('./background-sanity-v3-cases.json',import.meta.url),'utf8'));
 if(suite.schemaVersion!==3||suite.cases.length!==3)throw Error('Unexpected background v3 suite');
 return suite.cases.map((c:any)=>({id:`background.${c.id}`,split:'development',track:'agent',family:'audit',description:c.rubric.join(' '),steps:[{action:'send',text:`User: ${c.text}`}],roleCase:{id:c.id,split:'development',role:'audit',transcript:`User: ${c.text}`,memoryConsent:true,initialTerms:c.terms,forbiddenTools:c.voice?[]:['log_mistranscription','phonetic_candidates','add_auto_replace_rule'],rubric:c.rubric},backgroundSeed:{voice:c.voice,stt:c.stt,priorAudit:c.priorAudit,summary:c.summary,pronunciation:c.pronunciation,retrieval:c.retrieval,matchingProbes:c.matchingProbes},assertions:[{id:'valid_completion',kind:'completion',critical:true},{id:'schema_validity',kind:'tool_schema',critical:true}],rubric:c.rubric}));
}
