/** Controlled reference-service fixture; never a production retrieval benchmark. */
import {createHash} from "node:crypto";
import type {SourceEvidence} from "../src/corpus-tools.ts";
export interface FixtureContext {passage_id:string;source_sha256:string;text:string;source?:string;title?:string;printed_page?:string|null;}
const sha=(value:unknown)=>createHash("sha256").update(JSON.stringify(value)).digest("hex");
export class FixtureLibrary {
 readonly generation:string;
 readonly passages:SourceEvidence[];
 readonly requests:{kind:string;args:any}[]=[];
 constructor(contexts:FixtureContext[],readonly excerptCharacters=180){
  this.generation=sha(contexts);
  this.passages=contexts.map((context,index)=>({passage_id:`p:${this.generation}:${sha(context)}`,document_id:`doc-${context.source_sha256.slice(0,16)}`,source_revision:context.source_sha256,extraction_revision:"benchmark-inspected-v1",title:context.title??context.passage_id,edition:"benchmark fixture source version",section:[context.passage_id],page:{index:null,label:context.printed_page??null,coordinates:null,anchor:context.passage_id},excerpt:context.text,complete:true,previous:null,next:null,flags:[],source:{url:"",sha256:context.source_sha256,media_type:"text/plain",origin:context.source??"https://example.invalid/reference"}}));
  for(let i=0;i<this.passages.length;i++){
   const p=this.passages[i];p.source.url=`/v1/corpus/source/${encodeURIComponent(p.passage_id)}`;
   const siblings=this.passages.filter(other=>other.document_id===p.document_id);const j=siblings.indexOf(p);
   p.previous=siblings[j-1]?.passage_id??null;p.next=siblings[j+1]?.passage_id??null;
  }
 }
 envelope(){return {generation:this.generation,profile_id:"controlled-fixture-v1",status:"unqualified",degradation:[],coverage:{kind:"controlled-agent-scenario",not_a_retrieval_measurement:true,active_documents:new Set(this.passages.map(p=>p.document_id)).size}};}
 search(args:{query:string;document_id?:string;cursor?:string}){
  this.requests.push({kind:"search",args:structuredClone(args)});
  if(typeof args.query!=="string"||!args.query.trim())throw new Error("invalid_query");
  const terms=[...new Set(args.query.toLowerCase().match(/[\p{L}\p{N}]+/gu)??[])].filter(t=>t.length>2);
  const scored=this.passages.filter(p=>!args.document_id||p.document_id===args.document_id).map(p=>({p,score:terms.reduce((n,t)=>n+Number(`${p.title} ${p.excerpt}`.toLowerCase().includes(t)),0)})).filter(row=>row.score>0).sort((a,b)=>b.score-a.score||a.p.passage_id.localeCompare(b.p.passage_id));
  const offset=args.cursor?Number(args.cursor):0;if(!Number.isSafeInteger(offset)||offset<0)throw new Error("invalid_cursor");
  const rows=scored.slice(offset,offset+6);return {...this.envelope(),hits:rows.map(({p})=>({...p,excerpt:p.excerpt.slice(0,this.excerptCharacters),complete:p.excerpt.length<=this.excerptCharacters,flags:p.excerpt.length>this.excerptCharacters?["excerpt_omits_context"]:[]})),cursor:offset+6<scored.length?String(offset+6):null};
 }
 read(args:{document_id:string;passage_id?:string;cursor?:string}){
  this.requests.push({kind:"read",args:structuredClone(args)});
  const siblings=this.passages.filter(p=>p.document_id===args.document_id);if(!siblings.length)throw new Error("unknown_document");
  let selected:SourceEvidence[];
  if(args.passage_id){const index=siblings.findIndex(p=>p.passage_id===args.passage_id);if(index<0)throw new Error("unavailable_source_revision");selected=siblings.slice(Math.max(0,index-1),index+2);}
  else selected=siblings;
  const offset=args.cursor?Number(args.cursor):0;if(!Number.isSafeInteger(offset)||offset<0)throw new Error("invalid_cursor");
  return {...this.envelope(),passages:selected.slice(offset,offset+6),cursor:offset+6<selected.length?String(offset+6):null};
 }
 handle(kind:"search"|"read",args:any){return kind==="search"?this.search(args):this.read(args);}
}
