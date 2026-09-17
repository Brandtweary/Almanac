// Offline browser regression: real tool cards and styles, no model or audio requests.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {createServer} from 'vite';
import {chromium} from 'playwright';
import ts from 'typescript';
const source=ts.createSourceFile('main.ts',readFileSync(new URL('../src/main.ts',import.meta.url),'utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.TS);
const serving=source.statements.find(node=>ts.isFunctionDeclaration(node)&&node.name?.text==='resolveServingPath');
assert(serving,'Use the actual serving initialization function');
const registration=source.statements.filter(node=>ts.isExpressionStatement(node)&&ts.isCallExpression(node.expression)&&node.expression.expression.getText(source)==='registerReferenceToolRenderers').map(node=>node.getText(source)).join('\n');
const servingJs=ts.transpileModule(serving.getText(source),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText;
const html=`<!doctype html><html><head><meta charset="utf-8"><title>Tool rendering fixture</title></head><body><main style="max-width:800px;margin:24px auto"></main><script type="module">
import '/src/pi-web-ui/app.css';import '/src/theme.css';import '/src/app.css';
import '/src/pi-web-ui/components/Messages.ts';
import {registerReferenceToolRenderers} from '/src/reference-tool-renderers.ts';
const qualificationMode=true;const migrateLocalAccess=async()=>{};const loadReleaseProfile=async()=>{};const proxyChatModel=()=>({id:'fixture'});const MYRIAPOD_PROXY_BASE='/v1';
${servingJs}
await resolveServingPath();${registration}
const fixtures=[
 ['corpus_search',{query:'query_marker'},{status:'degraded',hits:[{title:'Reference one'},{title:'Reference two'}]},'search_payload_marker'],
 ['corpus_read',{document_id:'document_marker'},{status:'ok',passages:[{title:'Reference one'}]},'read_payload_marker'],
 ['conversation_history',{query:'history_query_marker'},{},'history_payload_marker'],
];
for(const [name,args,details,marker]of fixtures){const element=document.createElement('tool-message');element.id=name;element.toolCall={id:name,name,arguments:args};element.result={role:'toolResult',toolCallId:name,toolName:name,isError:false,timestamp:1,details,content:[{type:'text',text:JSON.stringify({marker,full_result:'Exact retained source text. '.repeat(80)})}]};document.querySelector('main').append(element);await element.updateComplete;}
window.fixtureReady=true;
</script></body></html>`;
const server=await createServer({root:process.cwd(),server:{host:'127.0.0.1',port:0},plugins:[{name:'offline-tool-fixture',configureServer(server){server.middlewares.use((req,res,next)=>{if(req.url==='/__reference-tool-fixture'){res.setHeader('Content-Type','text/html');res.end(html)}else next()})}}]});
let browser;
try{
 await server.listen();const address=server.httpServer.address();assert(address&&typeof address==='object');const origin=`http://127.0.0.1:${address.port}`;
 browser=await chromium.launch({executablePath:process.env.BROWSER_EXECUTABLE||execFileSync('which',['brave'],{encoding:'utf8'}).trim(),headless:true,args:['--mute-audio']});
 const page=await browser.newPage({viewport:{width:1100,height:750}});const errors=[];page.on('pageerror',error=>errors.push(String(error)));
 await page.route('**/*',route=>{const url=new URL(route.request().url());if(url.origin!==origin||url.pathname.startsWith('/v1')||url.pathname.startsWith('/voice'))return route.abort();return route.continue()});
 await page.addInitScript(()=>{window.AudioContext=class{constructor(){throw Error('Audio is forbidden in this UI regression')}};window.webkitAudioContext=window.AudioContext});
 await page.goto(`${origin}/__reference-tool-fixture`);await page.waitForFunction(()=>window.fixtureReady===true,{timeout:30000});
 assert.equal(await page.locator('#qualification-warning').count(),0,'Qualification state does not insert a banner');
 for(const name of['corpus_search','corpus_read','conversation_history']){
  const card=page.locator(`#${name}`);const panel=card.locator('tool-message-debug');await panel.waitFor({state:'attached'});
  await page.waitForFunction(id=>document.querySelector(`#${id} tool-message-debug code-block`),name);
  assert.equal(await panel.evaluate(element=>element.parentElement.getBoundingClientRect().height),0,`${name} starts with raw output hidden`);
  assert.equal(await card.locator('button').first().isVisible(),true,`${name} retains the existing disclosure control`);
  await card.locator('button').first().click();await page.waitForFunction(id=>document.querySelector(`#${id} tool-message-debug`).parentElement.getBoundingClientRect().height>50,name);
  assert(await panel.locator('code-block').count()>=2,'Existing call/result inspection is retained');
  assert(await panel.evaluate(element=>[...element.querySelectorAll('code-block')].some(block=>block.code?.includes('payload_marker'))),'Expanded inspector retains the original tool result');
  await card.locator('button').first().click();await page.waitForFunction(id=>document.querySelector(`#${id} tool-message-debug`).parentElement.getBoundingClientRect().height===0,name);
 }
 await page.evaluate(async()=>{const card=document.getElementById('corpus_read');window.originalReadResult=card.result;card.result=undefined;card.pending=true;await card.updateComplete});
 assert.match(await page.locator('#corpus_read button').first().innerText(),/Reading source/);
 assert.equal(await page.locator('#corpus_read tool-message-debug').evaluate(element=>element.parentElement.getBoundingClientRect().height),0);
 await page.evaluate(async()=>{const card=document.getElementById('corpus_read');card.pending=false;card.result={...window.originalReadResult,isError:true,content:[{type:'text',text:'failure_payload_marker'}]};await card.updateComplete});
 assert.match(await page.locator('#corpus_read button').first().innerText(),/Source read failed/);
 assert.equal(await page.locator('#corpus_read tool-message-debug').evaluate(element=>element.parentElement.getBoundingClientRect().height),0);
 await page.locator('#corpus_read button').first().click();await page.waitForFunction(()=>document.querySelector('#corpus_read tool-message-debug').parentElement.getBoundingClientRect().height>50);
 assert(await page.locator('#corpus_read tool-message-debug').evaluate(element=>[...element.querySelectorAll('code-block')].some(block=>block.code?.includes('failure_payload_marker'))));
 await page.locator('#corpus_read button').first().click();await page.waitForFunction(()=>document.querySelector('#corpus_read tool-message-debug').parentElement.getBoundingClientRect().height===0);
 await page.evaluate(async()=>{const card=document.getElementById('corpus_read');card.aborted=true;await card.updateComplete});
 await page.locator('#corpus_read button').first().click();await page.waitForFunction(()=>document.querySelector('#corpus_read tool-message-debug').parentElement.getBoundingClientRect().height>0);
 await page.locator('#corpus_read button').first().click();await page.waitForFunction(()=>document.querySelector('#corpus_read tool-message-debug').parentElement.getBoundingClientRect().height===0);
 await page.evaluate(async()=>{const card=document.getElementById('corpus_read');card.aborted=false;card.result=window.originalReadResult;await card.updateComplete});
 assert.match(await page.locator('#corpus_search button').first().innerText(),/2 passages.*incomplete results/);
 assert.match(await page.locator('#corpus_read button').first().innerText(),/Read source.*1 passage/);
 await page.screenshot({path:'/tmp/almanac-reference-tool-rendering.png'});
 assert.deepEqual(errors,[]);console.log('Browser verified: no qualification banner; three compact tool cards; raw JSON hidden initially; existing expand/collapse works; incomplete status retained; no inference or audio.');
}finally{await browser?.close();await server.close()}
