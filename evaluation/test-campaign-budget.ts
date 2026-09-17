import assert from "node:assert/strict";
import {mkdtempSync,rmSync,readFileSync,writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {CampaignBudget,CampaignReservations,claimCampaign} from "./campaign-budget.ts";
const dir=mkdtempSync(join(tmpdir(),"almanac-budget-"));
try{
 const file=join(dir,"ledger.json");const prior={ceilingUSD:10,priorReportedUSD:1,priorUnknownReserveUSD:2};let b=new CampaignBudget(file,prior);
 assert(b.reserve("a",4));assert(!b.reserve("b",4));
 b=new CampaignBudget(file,prior);assert.equal(b.totals().totalExposureUSD,7);assert.throws(()=>b.reserve("a",4),/cannot be replayed/);
 b.settle("a",.5,false);assert.equal(b.totals().totalExposureUSD,3.5);assert(b.reserve("b",4));b.settle("b",.25,true);assert.equal(b.totals().totalExposureUSD,7.5);
 b=new CampaignBudget(file,prior);assert.equal(b.totals().totalExposureUSD,7.5);
 assert(!b.reserve("c",3));assert.throws(()=>b.settle("a",0,false),/No unsettled/);assert.throws(()=>new CampaignBudget(file,{...prior,ceilingUSD:11}),/identity/);
 const release=claimCampaign(dir);assert.throws(()=>claimCampaign(dir),/ownership/);release();claimCampaign(dir)();
 const original=readFileSync(file,"utf8");
 for(const alter of [(d:any)=>{d.entries=null;},(d:any)=>{delete d.entries;},(d:any)=>{d.reportedUSD=0;},(d:any)=>{d.entries.a.reportedUSD=-1;}]){
  const damaged=JSON.parse(original);alter(damaged);const bytes=JSON.stringify(damaged);writeFileSync(file,bytes);assert.throws(()=>new CampaignBudget(file,prior),/persisted|aggregate/i);assert.equal(readFileSync(file,"utf8"),bytes);
 }
 writeFileSync(file,original);
 console.log("Campaign ledger preserves interrupted exposure, releases known usage, retains unknown usage, rejects duplicate launches and enforces the cumulative ceiling.");
}finally{rmSync(dir,{recursive:true,force:true});}

const queueDir=mkdtempSync(join(tmpdir(),"almanac-budget-queue-"));
try{
 const budget=new CampaignBudget(join(queueDir,"ledger.json"),{ceilingUSD:10,priorReportedUSD:0,priorUnknownReserveUSD:0});const slots=new CampaignReservations(budget);const ran:string[]=[];
 await Promise.all(["first","second","third"].map(async id=>{assert(await slots.acquire(id,6));await new Promise(resolve=>setTimeout(resolve,1));ran.push(id);slots.settle(id,.1,false);}));
 assert.equal(ran.length,3);assert(Math.abs(budget.totals().reportedUSD-.3)<1e-9);
 console.log("Temporary in-flight reservations defer competing cases; all affordable cases run after settlement.");
}finally{rmSync(queueDir,{recursive:true,force:true});}

const edgeDir=mkdtempSync(join(tmpdir(),"almanac-budget-partial-"));
try{
 const file=join(edgeDir,"ledger.json"),prior={ceilingUSD:10,priorReportedUSD:0,priorUnknownReserveUSD:0};let b=new CampaignBudget(file,prior);assert(b.reserve("at-ceiling",10));b.settle("at-ceiling",3,true);assert.equal(b.totals().totalExposureUSD,10);assert.equal(b.totals().reservedUSD,7);b=new CampaignBudget(file,prior);assert.equal(b.totals().totalExposureUSD,10);
 console.log("Partially known billing consumes its original reservation without double counting; exact-ceiling resume succeeds.");
}finally{rmSync(edgeDir,{recursive:true,force:true});}
