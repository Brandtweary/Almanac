import assert from 'node:assert/strict';
import { createServer } from 'vite';
const server = await createServer({optimizeDeps:{noDiscovery:true,include:[]},server:{middlewareMode:true,hmr:false},appType:'custom'});
try {
  const {speechCandidates} = await server.ssrLoadModule('/src/stt-candidates.ts');
  const {emptySttLexicon, applyAutoReplace, validateAutoReplace} = await server.ssrLoadModule('/src/stt-lexicon.ts');
  const {validateSttLexicon} = await server.ssrLoadModule('/src/memory-state.ts');
  const {createPipelineTools} = await server.ssrLoadModule('/src/pipeline-tools.ts');
  const {makePhonemizeClient} = await server.ssrLoadModule('/src/stt-phonemize.ts');
  const {Graph} = await server.ssrLoadModule('/src/kg/graph.ts');
  const evidence = (rawText:string) => ({utteranceId:'current',rawText,correctedText:rawText});
  const phonemize=async (texts:string[]) => ({phonemes:texts.map(text=>({'plain':'pleɪn','plane':'pleɪn'}[text] ?? text)),engine:{name:'espeak-ng',version:'fixture',voice:'en-us'}});
  const run = (raw:string, vocab:string[], lex = emptySttLexicon(), page = {}) => speechCandidates(evidence(raw),vocab,lex,page,phonemize);
  const compound = await run('Use wire plumber please.', ['WirePlumber']);
  assert.ok(compound.candidates.some((c:any) => c.heard==='wire plumber' && c.proposed==='WirePlumber'));
  for (const c of compound.candidates) assert.equal('Use wire plumber please.'.slice(c.start,c.end),c.heard);
  assert.equal((await run('wire. plumber', ['WirePlumber'])).candidates.some((c:any)=>c.heard==='wire. plumber'),false);
  for (const [heard,term] of [['knowledge graph','knowledge-graph'],['headless agents','headless-agent-py'],['audit agents','audit-agent'],['autofetch','auto-fetch']]) {
    assert.equal((await run(heard,[term])).candidates.some((c:any)=>c.heard===heard && c.proposed===term),false,'formatting/morphology is not an STT correction');
  }
  assert.ok((await run('kubernetees', ['Kubernetes'])).candidates.some((c:any)=>c.proposed==='Kubernetes'));
  const unicodeInputs:string[]=[];
  await speechCandidates(evidence('cafe\u0301 flora'),['jalapeño'],emptySttLexicon(),{},async(texts:string[])=>{unicodeInputs.push(...texts);return phonemize(texts);});
  assert.ok(unicodeInputs.includes('café')); assert.ok(unicodeInputs.includes('jalapeño'));
  assert.ok(!unicodeInputs.includes('cafe'));
  const spokenInputs:string[]=[];
  const spoken=await speechCandidates(evidence('Rough   road'),['ruff rode'],emptySttLexicon(),{},async(texts:string[])=>{
    spokenInputs.push(...texts);
    return {phonemes:texts.map(text=>text==='rough road'||text==='ruff rode'?'rʌf roʊd':'unmatched'),engine:{name:'espeak-ng',version:'fixture',voice:'en-us'}};
  });
  assert.ok(spokenInputs.includes('rough road'),'Native pronunciation retains normalized spoken word boundaries');
  assert.ok(!spokenInputs.includes('roughroad'),'Orthographic joins never enter native pronunciation requests');
  assert.ok(spoken.candidates.some((c:any)=>c.heard==='Rough   road'&&c.proposed==='ruff rode'&&c.distance===0),
    'Pronunciation lookup uses the same spaced key; this pair exceeds the spelling-distance threshold');

  assert.equal((await run('plain', ['plane'])).candidates.length,0);
  const lex=emptySttLexicon();
  const row={spoken:'plane',transcribed:'plain',kind:'phonetic',rawText:'plain',status:'accepted',ts:''};
  lex.mistranscriptions.push({...row,utteranceId:'a'},{...row,utteranceId:'a'});
  assert.equal((await run('plain',['plane'],lex)).candidates.length,0,'replays cannot corroborate common-word hints');
  lex.mistranscriptions.push({...row,utteranceId:'b'});
  const admitted=await run('plain',['plane'],lex);
  assert.deepEqual(admitted.candidates[0]?.utteranceIds,['a','b']);
  assert.equal((await run('plane',['plain'],lex)).candidates.length,0,'canonical forms cannot be inverted');
  lex.mistranscriptions.push({...row,status:'rejected',utteranceId:'c'});
  assert.equal((await run('plain',['plane'],lex)).candidates.length,0,'rejection wins over accepted duplicates');
  assert.equal((await run('v2.1',['v2.2'])).candidates.length,0);
  for (const [from,to] of [['release 3.1','release 3.2'],['seven','eleven'],['v1','v2']]) await assert.rejects(validateAutoReplace(from,to),/Numerical/);
  await validateAutoReplace('kuber netties 3','Kubernetes 3');
  await assert.rejects(validateAutoReplace('API file','api file'),/exact_case/);
  await validateAutoReplace('API file','api file',true);
  assert.equal(applyAutoReplace('API file api file Api file',[{from:'API file',to:'api file',exactCase:true,ts:''}]),'api file api file Api file');
  assert.throws(()=>validateSttLexicon({mistranscriptions:[],autoReplace:[{from:'x',to:'y',ts:'',exactCase:'yes'}]}),/Invalid/);
  const paged=await run('kubernetees',Array.from({length:260},(_,i)=>`target${i}`));
  assert.equal(paged.scope.targetEnd,256); assert.equal(paged.next.targetOffset,256);
  const next=await run('kubernetees',Array.from({length:260},(_,i)=>`target${i}`),undefined,paged.next);
  assert.equal(next.next,null); assert.equal(next.scope.targetEnd,260);
  const graph=new Graph({meta:{version:2,node_count:0,last_modified:''},thoughts:{}});
  graph.getOrCreate('Kubernetes','Container orchestration.');
  const state=emptySttLexicon(); let active=true;
  const tools=createPipelineTools({getGraph:()=>graph,getSttLexicon:()=>state,embed:async()=>null,record:()=>{},addFlag:()=>{},voiceEvidence:evidence('kubernetees'),phonemize,assertActive:()=>{if(!active)throw Error('revoked')}});
  const call=(name:string,p:any)=>tools.find((t:any)=>t.name===name).execute('test',p);
  const before=JSON.stringify(state); await call('phonetic_candidates',{}); assert.equal(JSON.stringify(state),before);
  const pending=call('phonetic_candidates',{}); active=false; await assert.rejects(pending,/revoked/);
  await assert.rejects(speechCandidates(evidence('kubernetees'),['Kubernetes'],state),/unavailable/);
  let revision=0;
  await assert.rejects(speechCandidates(evidence('kubernetees'),Array.from({length:260},(_,i)=>`target${i}`),state,{},async (texts:string[])=>{
    const result=await phonemize(texts); return {...result,engine:{...result.engine,version:String(revision++)}};
  }),/engine changed/);
  const savedFetch=globalThis.fetch;
  try {
    let requests=0;
    globalThis.fetch=async (_url:any,init:any)=>{
      requests++; assert.equal(init.headers.Authorization,'Bearer fixture');
      const body=JSON.parse(init.body); assert.deepEqual(body,{texts:['sample'],language:'en-us'});
      return new Response(JSON.stringify({phonemes:['sæmpəl'],engine:{name:'espeak-ng',version:'fixture',voice:'en-us'}}),{status:200});
    };
    const client=makePhonemizeClient({endpoint:'/v1/phonemize',getBearer:()=> 'fixture'});
    assert.deepEqual((await client(['sample'])).phonemes,['sæmpəl']);
    await assert.rejects(client(['x'.repeat(65)]),/bounded/); assert.equal(requests,1);
    globalThis.fetch=async()=>new Response('{}',{status:503});
    await assert.rejects(client(['sample']),/unavailable/);
    globalThis.fetch=async()=>new Response(JSON.stringify({phonemes:[],engine:{name:'espeak-ng',version:'fixture',voice:'en-us'}}));
    await assert.rejects(client(['sample']),/alignment/);
  } finally {globalThis.fetch=savedFetch;}
  console.log('Speech parity regressions passed');
} finally {await server.close();}
