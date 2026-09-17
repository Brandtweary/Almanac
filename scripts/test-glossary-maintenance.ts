import assert from "node:assert/strict";
import { test } from "node:test";
import { Graph } from "../src/kg/graph.js";
import { createPipelineTools } from "../src/pipeline-tools.js";
import { emptySttLexicon } from "../src/stt-lexicon.js";
import { createMaintenanceTool, emptyMaintenance, prepareMaintenance, forgetMaintenanceDecision, validateMaintenance } from "../src/glossary-maintenance.js";

function fixture() {
  const graph=Graph.empty();
  const a=graph.getOrCreate("garden-planner","A calendar for planning the community garden.");
  const b=graph.getOrCreate("garden-planning","The independent garden training program.");
  const state=emptyMaintenance(); let active=true;
  const actions:string[]=[];const merges:string[][]=[];
  const tool=createMaintenanceTool({graph,state,assertActive:()=>{if(!active) throw new Error("revoked");},record:line=>actions.push(line),onMerge:(a,b)=>merges.push([a,b])});
  const call=(p:any)=>tool.execute("test",p,undefined,undefined);
  return {graph,a,b,state,actions,merges,call,revoke:()=>{active=false;}};
}
test("imported backlog is discovered and distinct judgments bind across content edits until explicit forget",async()=>{
  const h=fixture();prepareMaintenance(h.graph,h.state);assert.equal(h.state.pending.length,1);
  const pair=h.state.pending[0];await h.call({operation:"distinct",ids:pair.ids,reason:"Separate projects"});
  h.graph.getOrCreate(h.a.label,"A revised calendar for community garden planning.");
  prepareMaintenance(h.graph,h.state);assert.equal(h.state.pending.length,0);
  assert.equal(h.state.decisions[0].before.find(t=>t.id===h.a.id)!.description,"A calendar for planning the community garden.");
  forgetMaintenanceDecision(h.state,pair.ids);prepareMaintenance(h.graph,h.state);
  assert.equal(h.state.pending.length,1);assert(h.state.decisions[0].forgottenAt);
  validateMaintenance(JSON.parse(JSON.stringify(h.state)));
});
test("pending pairs survive no judgment and deferral without granting merge authority",async()=>{
  const h=fixture();prepareMaintenance(h.graph,h.state);const pair=structuredClone(h.state.pending[0]);
  await h.call({operation:"defer",ids:pair.ids,reason:"Need more context"});pair.deferredReason="Need more context";assert.deepEqual(h.state.pending,[pair]);
  await assert.rejects(h.call({operation:"merged",ids:pair.ids,survivor_id:"absent",reason:"Same"}));
  assert.equal(h.graph.thoughts.size,2);assert.equal(h.state.decisions.length,0);
  const restored=structuredClone(h.state);prepareMaintenance(h.graph,restored);assert.deepEqual(restored.pending,[pair]);
});
test("successful merge retains both complete descriptions and records the actual survivor",async()=>{
  const h=fixture();prepareMaintenance(h.graph,h.state);const pair=h.state.pending[0];
  await h.call({operation:"merged",ids:pair.ids,survivor_id:h.a.id,reason:"Confirmed equivalent"});
  assert.equal(h.graph.thoughts.size,1);assert.deepEqual(h.merges,[[h.b.id,h.a.id]]);
  assert.equal(h.state.decisions[0].before.length,2);assert.equal(h.state.decisions[0].survivorId,h.a.id);
  assert.equal(h.state.decisions[0].before.find(t=>t.id===h.b.id)!.description,h.b.description);
  validateMaintenance(h.state);
});
test("changed in-flight candidate and revoked authority cannot mutate",async()=>{
  const h=fixture();prepareMaintenance(h.graph,h.state);const ids=h.state.pending[0].ids;
  h.graph.getOrCreate(h.a.label,"New meaning.");
  await assert.rejects(h.call({operation:"distinct",ids,reason:"Different"}),/changed/);
  prepareMaintenance(h.graph,h.state);h.revoke();
  await assert.rejects(h.call({operation:"merged",ids,survivor_id:h.a.id,reason:"Same"}),/revoked/);
  assert.equal(h.graph.thoughts.size,2);assert.equal(h.state.decisions.length,0);
});
test("direct pipeline merges cannot bypass a permanent distinct decision",async()=>{
  const h=fixture();prepareMaintenance(h.graph,h.state);
  await h.call({operation:"distinct",ids:h.state.pending[0].ids,reason:"Different"});
  const tools=createPipelineTools({getGraph:()=>h.graph,getSttLexicon:emptySttLexicon,embed:async()=>null,addFlag:()=>{},record:()=>{},maintenance:h.state});
  const merge=tools.find(t=>t.name==="merge_terms")!;
  await assert.rejects(merge.execute("merge",{loser:h.b.label,survivor:h.a.label},undefined,undefined),/binding distinct/);
  assert.equal(h.graph.thoughts.size,2);
  forgetMaintenanceDecision(h.state,[h.a.id,h.b.id]);
  await merge.execute("merge",{loser:h.b.label,survivor:h.a.label},undefined,undefined);
  assert.equal(h.state.decisions.at(-1)!.verdict,"merged");assert.equal(h.state.decisions.at(-1)!.before.length,2);
});
test("pair caps pause the scan and repeated adjudication drains every imported pair",async()=>{
  const graph=Graph.empty();for(let i=0;i<12;i++) graph.getOrCreate(`orchard-schedule-${i}`,`Independent plan ${i}.`);
  const state=emptyMaintenance();const tool=createMaintenanceTool({graph,state,assertActive:()=>{},record:()=>{},onMerge:()=>{}});
  prepareMaintenance(graph,state,10000);assert.equal(state.pending.length,32);assert(state.work.length>0);
  const waiting=structuredClone(state.work);prepareMaintenance(graph,state,7);
  for(const work of waiting) assert(state.work.some(row=>row.id===work.id && row.after===work.after), "A full queue must preserve every unfinished scan cursor");
  let rounds=0;
  while(state.decisions.length<66 && rounds++<100){
    for(const pair of [...state.pending]) await tool.execute("distinct",{operation:"distinct",ids:pair.ids,reason:"Independent"},undefined,undefined);
    prepareMaintenance(graph,state,7);
    assert(state.pending.length<=32);
  }
  assert.equal(state.decisions.length,66);assert(rounds<100);
  const page=await tool.execute("decisions",{operation:"decisions"},undefined,undefined);
  const parsed=JSON.parse((page.content[0] as any).text);assert.equal(parsed.rows.length,4);assert.equal(parsed.next,4);
});
test("semantic candidates require matching encoder identity and new terms enter work",()=>{
  const graph=Graph.empty();const a=graph.getOrCreate("azalea","Flowering shrub.");const b=graph.getOrCreate("quartz","Mineral specimen.");
  a.embedding=[1,0];b.embedding=[1,0];a.embedding_encoder="one";b.embedding_encoder="two";
  const state=emptyMaintenance();prepareMaintenance(graph,state);assert.equal(state.pending.length,0);
  b.embedding_encoder="one";prepareMaintenance(graph,state);assert.equal(state.pending.length,1);
  const c=graph.getOrCreate("quartzite","Another rock.");prepareMaintenance(graph,state);assert(state.pending.some(p=>p.ids.includes(c.id)));
});
test("invalid persisted review evidence fails closed",()=>{
  const state=emptyMaintenance();assert.throws(()=>validateMaintenance({...state,pending:[{ids:["x","x"],fingerprints:["a","b"]}]}));
  assert.throws(()=>validateMaintenance({...state,decisions:[{ids:["x","y"],fingerprints:["a","b"],verdict:"distinct",reason:"Different",ts:"now",before:[]}]}));
});
