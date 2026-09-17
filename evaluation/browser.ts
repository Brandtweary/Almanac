/** Run the stock browser subset; credentials stay in the loopback developer bridge. */
import type {PriorBudget} from "./campaign-budget.js";
import { chromium, type Page } from "playwright";
import {readFileSync,writeFileSync,appendFileSync,mkdirSync,existsSync,readdirSync,cpSync} from "node:fs";
import {createHash} from "node:crypto";
import {execFileSync} from "node:child_process";
import {fileURLToPath} from "node:url";
import {FixtureLibrary} from "./library.js";
import {startBrowserBridge,type BrowserCandidate} from "./browser-bridge.js";
const hash=(v:unknown)=>createHash("sha256").update(typeof v==="string"?v:JSON.stringify(v)).digest("hex");
const root=fileURLToPath(new URL("..",import.meta.url));
export async function inspectBrowserState(page:Page):Promise<any>{
 return page.evaluate(()=>new Promise((resolve,reject)=>{
  const open=indexedDB.open("pi-web-ui-example");open.onerror=()=>reject(open.error);open.onsuccess=()=>{
   const db=open.result;const names=[...db.objectStoreNames];const tx=db.transaction(names,"readonly");const result:Record<string,unknown>={};
   for(const name of names){const request=tx.objectStore(name).getAll();request.onsuccess=()=>{result[name]=request.result;};}
   tx.oncomplete=()=>{db.close();resolve(result);};tx.onerror=()=>{db.close();reject(tx.error);};
  };
 }));
}
async function until<T>(read:()=>Promise<T>,predicate:(value:T)=>boolean,timeoutMs=120000):Promise<T>{const deadline=Date.now()+timeoutMs;while(Date.now()<deadline){const value=await read();if(predicate(value))return value;await new Promise(resolve=>setTimeout(resolve,100));}throw new Error("Observable condition timed out");}
async function send(page:Page,text:string){const editor=page.getByPlaceholder("Type a message...");await editor.fill(text);await editor.press("Enter");}
async function chooseConsent(page:Page,enabled:boolean){await page.getByRole("button",{name:enabled?"Yes, remember":"No thanks",exact:true}).click({timeout:15000});}
async function closeDialog(page:Page){await page.keyboard.press("Escape");}
function publishedJobs(state:any){return (state.pipeline??[]).find((value:any)=>value&&typeof value==="object"&&Array.isArray(value.jobs));}
export async function runBrowserSubset(options:{candidate:BrowserCandidate;output:string;priorBudget?:PriorBudget;apiKey?:string;scripted?:boolean;only?:string[]}){
 if(existsSync(options.output))throw new Error("Use a fresh browser receipt directory");mkdirSync(options.output,{recursive:true});
 const suite=JSON.parse(readFileSync(new URL("./browser-scenarios.json",import.meta.url),"utf8"));
 const fixtures=JSON.parse(readFileSync(new URL("./fixtures.json",import.meta.url),"utf8"));
 const development=new Set(fixtures.cases.filter((c:any)=>c.split==="development").flatMap((c:any)=>c.gold_context));
 const library=new FixtureLibrary(Object.entries(fixtures.contexts).filter(([id])=>development.has(id)).map(([,c])=>c) as any[]);
 let activeCase="initialization";
 cpSync(`${root}/dist`,`${options.output}/application`,{recursive:true});
 const bridge=await startBrowserBridge({dist:`${options.output}/application`,output:options.output,priorBudget:options.priorBudget,candidate:options.candidate,library,apiKey:options.apiKey,scripted:options.scripted,onReceiptEvent:event=>appendFileSync(`${options.output}/requests.jsonl`,JSON.stringify({caseId:activeCase,event})+"\n")});
 const browserEnv={...process.env};delete browserEnv.OPENROUTER_API_KEY;
 const browser=await chromium.launch({headless:true,env:browserEnv,args:["--use-fake-device-for-media-stream","--use-fake-ui-for-media-stream"]});const cases:any[]=[];
 const revision=execFileSync("git",["rev-parse","HEAD"],{cwd:root,encoding:"utf8"}).trim();
 const sourcePaths=[...new Set(execFileSync("git",["ls-files","-co","--exclude-standard","--","src","evaluation","proxy/queue.ts"],{cwd:root,encoding:"utf8"}).trim().split("\n"))].sort();
 const sources=sourcePaths.filter(path=>existsSync(`${root}/${path}`)).map(path=>({path,digest:hash(readFileSync(`${root}/${path}`,"utf8"))}));
 const bundle=readdirSync(`${root}/dist`,{recursive:true,withFileTypes:true}).filter(entry=>entry.isFile()).map(entry=>({path:`${entry.parentPath}/${entry.name}`.slice(`${root}/dist/`.length),digest:createHash("sha256").update(readFileSync(`${entry.parentPath}/${entry.name}`)).digest("hex")})).sort((a,b)=>a.path.localeCompare(b.path));
 const report:any={schemaVersion:1,runId:new Date().toISOString(),suiteDigest:hash(suite),implementation:{revision,dirtyDigest:hash(sources),sources,bundleDigest:hash(bundle),bundle},profile:{...options.candidate,transport:options.scripted?"controlled-transport-contract":"openrouter-developer-only",tokenizer:"conservative-byte-bound-not-native",settings:{temperature:0,stream:true}},cases,reportedCostUSD:0};
 const persist=()=>{report.reportedCostUSD=bridge.costUSD;report.unknownBilling=bridge.unknownBilling;writeFileSync(`${options.output}/report.json`,JSON.stringify(report,null,2));};
 try{
  for(const fixture of suite.cases){if(options.only&&!options.only.includes(fixture.id))continue;activeCase=fixture.id;
   const context=await browser.newContext({permissions:["microphone"]});const page=await context.newPage();page.setDefaultTimeout(15000);
   const errors:string[]=[];const consoleMessages:any[]=[];const network:any[]=[];page.on("pageerror",error=>errors.push(error.message));page.on("console",message=>consoleMessages.push({type:message.type(),text:message.text()}));page.on("requestfailed",request=>network.push({url:request.url(),failure:request.failure()}));page.on("response",response=>network.push({url:response.url(),status:response.status()}));
   const requestStart=bridge.requests.length, eventStart=bridge.events.length, sourceStart=library.requests.length, started=performance.now();
   console.log(JSON.stringify({case:fixture.id,phase:"start"}));
   const checks:any[]=[];const snapshots:any[]=[];let failure:unknown;let finalText="";
   const check=(id:string,passed:boolean,evidence:unknown)=>{checks.push({id,passed,critical:true,evidence});};
   try{
    await bridge.setFault("none");await page.goto(bridge.url);await page.getByPlaceholder("Type a message...").waitFor();console.log(JSON.stringify({case:fixture.id,phase:"ready"}));
    if(fixture.id==="browser-research-off-reload"){
     await send(page,fixture.steps[0].text);await chooseConsent(page,false);
     await until(async()=>bridge.requests.slice(requestStart),rows=>rows.some(r=>r.role==="chat"&&r.state==="completed")&&rows.filter(r=>r.role==="chat").every(r=>r.state==="completed"));
     await until(async()=>inspectBrowserState(page),state=>state.sessions?.some((s:any)=>s.messages?.some((m:any)=>m.role==="assistant"&&m.stopReason==="stop")));
     // A terminal assistant answer, rather than an intermediate tool-call completion, owns readiness.
     await page.locator("message-editor textarea").waitFor();
     const saved=await inspectBrowserState(page);snapshots.push(saved);finalText=await page.locator("assistant-message").allTextContents().then(text=>text.join("\n"));
     const calls=library.requests.slice(sourceStart);check("corpus-search-read-visible",calls.some(r=>r.kind==="search")&&calls.some(r=>r.kind==="read")&&(await page.locator("tool-message").count())>0,{calls,visibleToolCards:await page.locator("tool-message").count()});
     check("consent-off-no-workers",bridge.requests.slice(requestStart).every(r=>r.role==="chat"),bridge.requests.slice(requestStart).map(r=>r.role));
     const links=await page.locator('a[href*="/v1/corpus/source/"]').count();check("known-source-links",links>0&&await page.locator('a[aria-invalid="true"]').count()===0,{links});
     if(links){const popup=page.waitForEvent("popup");await page.locator('a[href*="/v1/corpus/source/"]').first().click();const sourcePage=await popup;await sourcePage.waitForLoadState();const original=await sourcePage.locator("body").innerText();check("cited-source-opens",library.passages.some(p=>original.includes(p.source_revision)&&original.includes(p.excerpt)),{sourceText:original});await sourcePage.close();}
     await page.reload();await page.getByPlaceholder("Type a message...").waitFor();await until(async()=>page.locator("assistant-message").count(),n=>n>0);
     const restored=await inspectBrowserState(page);snapshots.push(restored);check("saved-chat-restored",hash(saved.sessions)===hash(restored.sessions),{before:hash(saved.sessions),after:hash(restored.sessions)});
     check("raw-history-restored",restored.sessions.every((s:any)=>s.rawHistory?.records?.some((r:any)=>r.message.role==="user")&&s.rawHistory?.records?.some((r:any)=>r.message.role==="assistant")),restored.sessions.map((s:any)=>({id:s.id,complete:s.rawHistory?.complete,records:s.rawHistory?.records?.length})));
     const knownBefore=await page.locator('a[href*="/v1/corpus/source/"]').count();
     await page.keyboard.press("Control+Space");await page.locator(".cw-mic--rec").waitFor();
     check("voice-start-preserves-citations",knownBefore>0&&await page.locator('a[href*="/v1/corpus/source/"]').count()===knownBefore&&await page.locator('a[aria-invalid="true"]').count()===0,{knownBefore,knownAfter:await page.locator('a[href*="/v1/corpus/source/"]').count()});
     await page.getByTitle("New Chat",{exact:true}).click();await page.keyboard.press("Control+Space");
    } else if(fixture.id==="browser-memory-conversation-reload"){
     await send(page,fixture.steps[1].text);await chooseConsent(page,true);
     const first=await until(()=>inspectBrowserState(page),state=>{const p=publishedJobs(state);return p?.jobs?.length>0&&p.jobs.every((j:any)=>Object.values(j.stages).every(s=>s==="complete"));});snapshots.push(first);
     check("stages-published",true,publishedJobs(first));
     await page.getByTitle("New Chat",{exact:true}).click();await until(async()=>page.locator("assistant-message").count(),count=>count===0,15000);await send(page,fixture.steps[4].text);
     const second=await until(()=>inspectBrowserState(page),state=>{const p=publishedJobs(state);return state.sessions?.length>=2&&p?.jobs?.length>=2&&p.jobs.every((j:any)=>Object.values(j.stages).every(s=>s==="complete"));});snapshots.push(second);
     check("two-session-records",new Set(second.sessions.map((s:any)=>s.id)).size>=2,{ids:second.sessions.map((s:any)=>s.id)});
     finalText=await page.locator("assistant-message").allTextContents().then(text=>text.join("\n"));await page.reload();await page.getByPlaceholder("Type a message...").waitFor();
     const restored=await inspectBrowserState(page);snapshots.push(restored);check("memory-survives-reload",hash(second.lexicon)===hash(restored.lexicon),{before:hash(second.lexicon),after:hash(restored.lexicon)});
     await page.getByTitle("Settings",{exact:true}).click();await page.getByRole("button",{name:"Turn memory off",exact:true}).click();await page.getByRole("button",{name:"Turn memory on",exact:true}).waitFor();await closeDialog(page);
     const off=await inspectBrowserState(page);snapshots.push(off);check("consent-ui-off",off["memory-consent"]?.includes("declined"),off["memory-consent"]);
    } else {
     const waiting=fixture.id==="browser-cancel-waiting";await bridge.setFault(waiting?"hold-waiting":"hold-executing");
     await send(page,fixture.steps[1].text);await chooseConsent(page,false);
     const request=await until(async()=>bridge.requests.slice(requestStart).at(-1),r=>Boolean(r&&r.state===(waiting?"waiting":"executing")),15000);
     await page.locator("#oracle-request-state").getByRole("button",{name:"Cancel",exact:true}).click();
     await until(async()=>bridge.requests.find(r=>r.id===request!.id),r=>r?.state==="interrupted",15000);
     const terminal=bridge.events.slice(eventStart).filter((event:any)=>event.id===request!.id&&event.state==="interrupted");
     check(waiting?"queue-interrupted":"execution-interrupted",terminal.length===1,terminal);
     check(waiting?"no-inference-after-cancel":"slot-released",request!.frames===undefined&&request!.costUSD===undefined,request!.state);
     snapshots.push(await inspectBrowserState(page));
    }
    check("no-browser-exceptions",errors.length===0,errors);
   }catch(error){failure=error instanceof Error?error.message:String(error);snapshots.push(await inspectBrowserState(page).catch(()=>({inspectionFailed:true})));}
   const requests=bridge.requests.slice(requestStart);const hasTransportFailure=requests.some(r=>r.response?.httpStatus>=400||String(r.response?.error??"").startsWith("provider_transport_"));
   const applicationFailure=snapshots.some(state=>state.sessions?.some((s:any)=>s.messages?.some((m:any)=>m.role==="assistant"&&(m.stopReason==="error"||m.errorMessage))));
   const status=failure?(hasTransportFailure?"transport_error":applicationFailure?"failed":"evaluator_error"):checks.some(c=>!c.passed)?"failed":fixture.rubric.length?"unadjudicated":"passed";
   const artifact=`${fixture.id}.json`;writeFileSync(`${options.output}/${artifact}`,JSON.stringify({fixture,checks,failure,requests,queueEvents:bridge.events.slice(eventStart),sourceRequests:library.requests.slice(sourceStart),snapshots,answer:finalText,browserErrors:errors,consoleMessages,network},null,2));
   await page.screenshot({path:`${options.output}/${fixture.id}.png`,fullPage:true}).catch(()=>{});
   console.log(JSON.stringify({case:fixture.id,phase:"finished",status,failure}));
   cases.push({caseId:fixture.id,caseDigest:hash(fixture),status,failureCategory:failure?(hasTransportFailure?"provider_transport":applicationFailure?"application":"evaluator"):undefined,checks,metrics:{seconds:(performance.now()-started)/1000,inputTokens:requests.reduce((n,r)=>n+(r.inputTokens??0),0),outputTokens:requests.reduce((n,r)=>n+(r.outputTokens??0),0),costUSD:requests.reduce((n,r)=>n+(r.costUSD??0),0)},artifacts:[artifact,`${fixture.id}.png`]});persist();
   await context.close();await bridge.setFault("none");
  }
 }finally{await browser.close();await bridge.close();persist();}
 return report;
}
if(process.argv[1]&&resolvePath(process.argv[1])===fileURLToPath(import.meta.url)){
 const [profilePath,output,...flags]=process.argv.slice(2);if(!profilePath||!output)throw new Error("Usage: tsx evaluation/browser.ts PROFILE.json NEW_OUTPUT_DIRECTORY [--contracts-only]");
 const candidate=JSON.parse(readFileSync(profilePath,"utf8"));const casesArg=flags.find(flag=>flag.startsWith("--cases="));
 const only=flags.includes("--contracts-only")?["browser-cancel-waiting","browser-cancel-executing"]:casesArg?casesArg.slice(8).split(","):undefined;
 const priorArg=flags.find(flag=>flag.startsWith("--prior-budget="));
 const priorBudget=priorArg?JSON.parse(readFileSync(priorArg.slice(15),"utf8")):undefined;
 const result=await runBrowserSubset({candidate,output,priorBudget,apiKey:process.env.OPENROUTER_API_KEY,scripted:flags.includes("--contracts-only"),only});
 console.log(JSON.stringify({cases:result.cases.map((c:any)=>({id:c.caseId,status:c.status})),reportedCostUSD:result.reportedCostUSD,unknownBilling:result.unknownBilling}));
}
function resolvePath(value:string){return fileURLToPath(new URL(value,`file://${process.cwd()}/`));}
