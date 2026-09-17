/** Actual application-contract probes with synthetic browser storage. */
import {IDBFactory,IDBKeyRange} from "fake-indexeddb";
import {PipelineRuntime} from "../src/pipeline.ts";
import {MemoryStorage} from "../src/memory-storage.ts";
import {IndexedDBStorageBackend} from "../src/pi-web-ui/storage/backends/indexeddb-storage-backend.ts";
import {Graph} from "../src/kg/graph.ts";
export async function verifyConsentOff(transcript:string){
 globalThis.indexedDB??=new IDBFactory();globalThis.IDBKeyRange??=IDBKeyRange;
 const raw=new IndexedDBStorageBackend({dbName:`benchmark-consent-${crypto.randomUUID()}`,version:1,stores:["lexicon","pipeline","memory-consent"].map(name=>({name}))});
 const storage=new MemoryStorage(raw);let graph=Graph.empty();let requests=0;let publications=0;
 const runtime=new PipelineRuntime({backend:raw,getGraph:()=>graph,setGraph:next=>{graph=next;},publishMemory:async(asset,state)=>{publications++;await storage.save({graph:asset,pipeline:state});},embed:async()=>null,getModel:()=>({} as any),getBaseUrl:()=>"unused",getModelId:()=>"unused",getAuth:()=>"",getConsent:()=>"declined",addCost:()=>{},onStateChange:()=>{},onActivity:()=>{},onError:()=>{},measureContext:async()=>1,getRoleInputBudget:()=>1000,runLoop:async()=>{requests++;throw new Error("Consent leaked model request");}});
 runtime.loadSnapshot(await storage.load());runtime.startSession("synthetic-consent");runtime.onTurnEnd(()=>[{role:"user",content:transcript,timestamp:1}],false);await runtime.whenIdle();
 return {requests,publications,terms:graph.thoughts.size,jobs:runtime.snapshot().jobs?.length??0};
}
