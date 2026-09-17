/** Durable single-runner reservations survive missing receipts and interrupted requests. */
import {existsSync,readFileSync,writeFileSync,renameSync,mkdirSync,rmSync} from "node:fs";
import path from "node:path";
export function claimCampaign(output:string){
 const lock=path.join(output,".campaign-owner");
 try{mkdirSync(lock);}catch{throw new Error("Campaign ownership is already claimed. Inspect the owner and retained reservations before explicitly clearing a stale lock.");}
 writeFileSync(path.join(lock,"owner.json"),JSON.stringify({pid:process.pid,startedUTC:new Date().toISOString()})+"\n");
 let active=true;const release=()=>{if(active){active=false;rmSync(lock,{recursive:true,force:true});}};
 process.once("exit",release);return release;
}
export interface PriorBudget {ceilingUSD:number;priorReportedUSD:number;priorUnknownReserveUSD:number;}
type Entry={exposureUSD:number;status:"reserved"|"settled";reportedUSD:number;unknownReserveUSD:number};
export class CampaignBudget {
 readonly entries:Record<string,Entry>={};
 constructor(readonly file:string,readonly prior:PriorBudget){
  for(const n of Object.values(prior))if(typeof n==="number"&&(!Number.isFinite(n)||n<0))throw new Error("Invalid prior budget");
  if(!Number.isFinite(prior.ceilingUSD)||prior.ceilingUSD<=0||!Number.isFinite(prior.priorReportedUSD)||!Number.isFinite(prior.priorUnknownReserveUSD))throw new Error("Complete finite prior budget required");
  if(prior.priorReportedUSD+prior.priorUnknownReserveUSD>prior.ceilingUSD)throw new Error("Prior exposure exceeds ceiling");
  if(existsSync(file)){
   const old=JSON.parse(readFileSync(file,"utf8"));
   if(!old||old.schemaVersion!==1||!old.entries||typeof old.entries!=="object"||Array.isArray(old.entries))throw new Error("Invalid persisted budget envelope");
   if(JSON.stringify(old.prior)!==JSON.stringify(prior))throw new Error("Budget identity mismatch");
   for(const e of Object.values(old.entries) as Entry[]){
    if(!e||!["reserved","settled"].includes(e.status)||[e.exposureUSD,e.reportedUSD,e.unknownReserveUSD].some(n=>!Number.isFinite(n)||n<0)||e.exposureUSD<=0||e.reportedUSD>e.exposureUSD+1e-9||e.reportedUSD+e.unknownReserveUSD>e.exposureUSD+1e-9||e.status==="reserved"&&(e.reportedUSD!==0||e.unknownReserveUSD!==0))throw new Error("Invalid persisted budget entry");
   }
   Object.assign(this.entries,old.entries);
   for(const [key,value] of Object.entries(this.totals()))if(!Number.isFinite(old[key])||Math.abs(old[key]-value)>1e-9)throw new Error("Persisted budget aggregate mismatch");
   if(this.totals().totalExposureUSD>prior.ceilingUSD+1e-9)throw new Error("Persisted exposure exceeds ceiling");
  }
  this.save();
 }
 totals(){const es=Object.values(this.entries);const reportedUSD=es.reduce((s,e)=>s+e.reportedUSD,0);const reservedUSD=es.reduce((s,e)=>s+(e.status==="reserved"?e.exposureUSD:e.unknownReserveUSD),0);return {reportedUSD,reservedUSD,totalExposureUSD:this.prior.priorReportedUSD+this.prior.priorUnknownReserveUSD+reportedUSD+reservedUSD};}
 reserve(id:string,exposureUSD:number){
  if(this.entries[id])throw new Error("Existing reservation cannot be replayed; use a separately identified retry");
  if(!Number.isFinite(exposureUSD)||exposureUSD<=0)throw new Error("Positive finite exposure required");
  if(this.totals().totalExposureUSD+exposureUSD>this.prior.ceilingUSD)return false;
  this.entries[id]={exposureUSD,status:"reserved",reportedUSD:0,unknownReserveUSD:0};this.save();return true;
 }
 settle(id:string,reportedUSD:number,incomplete:boolean){
  const e=this.entries[id];if(!e||e.status!=="reserved")throw new Error("No unsettled reservation");
  if(!Number.isFinite(reportedUSD)||reportedUSD<0)throw new Error("Invalid reported cost");
  e.reportedUSD=reportedUSD;e.unknownReserveUSD=incomplete?Math.max(0,e.exposureUSD-reportedUSD):0;e.status="settled";this.save();
  if(reportedUSD>e.exposureUSD+1e-9)throw new Error("Provider charge exceeded frozen exposure; halt campaign");
 }
 private save(){writeFileSync(this.file+".tmp",JSON.stringify({schemaVersion:1,prior:this.prior,entries:this.entries,...this.totals()},null,2)+"\n");renameSync(this.file+".tmp",this.file);}
}
/** A temporary reservation must settle before insufficient funds becomes a skipped case. */
export class CampaignReservations {
 private active=0;
 private waiting:Array<()=>void>=[];
 constructor(readonly budget:CampaignBudget){}
 async acquire(id:string,exposureUSD:number){
  while(!this.budget.reserve(id,exposureUSD)){
   if(this.active===0)return false;
   await new Promise<void>(resolve=>this.waiting.push(resolve));
  }
  this.active++;return true;
 }
 settle(id:string,reportedUSD:number,incomplete:boolean){
  try{this.budget.settle(id,reportedUSD,incomplete);}
  finally{this.active--;const waiting=this.waiting.splice(0);for(const wake of waiting)wake();}
 }
}
