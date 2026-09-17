import assert from 'node:assert/strict';
import {readFileSync,mkdirSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {createServer} from 'vite';
import {chromium} from 'playwright';
import ts from 'typescript';
const source=ts.createSourceFile('main.ts',readFileSync(new URL('../src/main.ts',import.meta.url),'utf8'),ts.ScriptTarget.Latest,true);
function extract(name){let result;function visit(n){if(ts.isVariableDeclaration(n)&&n.name.getText(source)===name)result=n.initializer.getText(source);ts.forEachChild(n,visit)}visit(source);assert(result,name);return ts.transpileModule(`const ${name}=${result};`,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText;}
const html=`<!doctype html><html class="dark"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head><body class="bg-background text-foreground" style="height:100dvh;margin:0;display:flex;flex-direction:column"><div id="header"></div><div id="chat" style="flex:1;min-height:0"></div><div id="about" style="flex:1;overflow:auto;display:none"></div><script type="module">
import '/src/app.css';
import {html,render} from 'lit';import {unsafeHTML} from 'lit/directives/unsafe-html.js';import {marked} from 'marked';
import {Button} from '@mariozechner/mini-lit/dist/Button.js';import {Input} from '@mariozechner/mini-lit/dist/Input.js';import {icon} from '@mariozechner/mini-lit';import {History,Plus,Settings} from 'lucide';
import aboutDoc from '/about-almanac.md?raw';
import {ChatPanel} from '/src/pi-web-ui/ChatPanel.ts';import {QuickStartTour} from '/src/quick-start-tour.ts';
import {VoiceController} from '/src/voice.ts';import {MemoryButton} from '/src/memory-button.ts';import {StopAudioButton} from '/src/stop-audio-button.ts';import {setAppStorage} from '/src/pi-web-ui/storage/app-storage.ts';
setAppStorage({providerKeys:{get:async()=> 'local'}});
window.micCalls=0;navigator.mediaDevices.getUserMedia=async()=>{window.micCalls++;throw Error('No recording in tour test')};
let currentView='chat',currentTitle='',isEditingTitle=false;const headerHost=document.getElementById('header');const dbg=()=>{};const openSettings=()=>{};let quickStartTour;
const setView=view=>{currentView=view;document.getElementById('chat').style.display=view==='chat'?'':'none';document.getElementById('about').style.display=view==='about'?'':'none';renderHeader();};
const agent=messages=>{const listeners=new Set();const a={state:{model:{id:'fixture',provider:'fixture',reasoning:false},messages,tools:[],isStreaming:false,pendingToolCalls:new Set(),thinkingLevel:'off'},subscribe:cb=>{listeners.add(cb);return()=>listeners.delete(cb)},streamFn:()=>{},getApiKey:()=> 'local',prompt:async message=>{if(window.failSend)throw Error('Fixture admission failure');a.state.messages.push(message);for(const cb of listeners)await cb({type:'message_start',message});for(const cb of listeners)await cb({type:'message_end',message});for(const cb of listeners)await cb({type:'agent_end',messages:a.state.messages});}};return a;};
const panel=new ChatPanel();document.getElementById('chat').append(panel);window.panel=panel;
window.load=async messages=>{await panel.setAgent(agent(messages));await panel.updateComplete;await panel.agentInterface.updateComplete;panel.agentInterface.enableModelSelector=false;panel.agentInterface.enableThinkingSelector=false;await panel.agentInterface.updateComplete;await panel.querySelector('message-editor').updateComplete;};
const newSession=()=>window.load([]);
${extract('renderAbout')}
${extract('renderHeader')}
render(renderAbout(),document.getElementById('about'));
await window.load([]);
window.controls=[new VoiceController({}),new MemoryButton({getVisual:()=> 'off',onClick:()=>{}}),new StopAudioButton({isMuted:()=>false,onCut:()=>{},onToggleMute:()=>{}})];
quickStartTour=new QuickStartTour();window.tour=quickStartTour;renderHeader();quickStartTour.startIfNew();window.ready=true;
</script></body></html>`;
const server=await createServer({root:process.cwd(),server:{host:'127.0.0.1',port:0},plugins:[{name:'onboarding-fixture',configureServer(server){server.middlewares.use(async(req,res,next)=>{if(req.url==='/__onboarding'){res.setHeader('Content-Type','text/html');res.end(await server.transformIndexHtml(req.url,html))}else next()})}}]});
const out=process.env.ONBOARDING_SCREENSHOTS||'/tmp/almanac-onboarding';mkdirSync(out,{recursive:true});let browser;
try{
 await server.listen();const origin=`http://127.0.0.1:${server.httpServer.address().port}`;
 browser=await chromium.launch({executablePath:process.env.BROWSER_EXECUTABLE||execFileSync('which',['brave'],{encoding:'utf8'}).trim(),headless:true});
 for(const [name,viewport]of[['desktop',{width:1280,height:900}],['mobile',{width:390,height:844}]]){
  const page=await browser.newPage({viewport});const errors=[];page.on('pageerror',e=>{errors.push(String(e));console.error(e)});
  await page.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.abort());
  await page.goto(origin+'/__onboarding');await page.waitForFunction(()=>window.ready===true);
  const tour=page.getByRole('dialog',{name:'Start with a question'});await tour.waitFor();
  assert.equal(await page.locator('.cw-onboarding').count(),1);assert.match(await tour.textContent(),/Enter sends/);
  await page.screenshot({path:out+'/'+name+'-tour.png'});
  await tour.getByRole('button',{name:'Next',exact:true}).click();await page.getByRole('dialog',{name:'Voice input'}).waitFor();
  await page.keyboard.press('Control+Space');assert.equal(await page.evaluate(()=>window.micCalls),0);
  await page.screenshot({path:out+'/'+name+'-microphone.png'});
  await page.getByRole('button',{name:'Back',exact:true}).click();assert.equal(await tour.count(),1);
  await page.getByRole('button',{name:'Skip tour',exact:true}).click();assert.equal(await page.locator('dialog[open]').count(),0);
  await page.reload();await page.waitForFunction(()=>window.ready===true);assert.equal(await page.locator('dialog[open]').count(),0,'skip persists');
  const textarea=page.locator('message-editor textarea');const examples=page.getByRole('group',{name:'Example questions'});
  await page.getByRole('button',{name:'Why is my compost staying wet?',exact:true}).click();assert.equal(await textarea.inputValue(),'Why is my compost staying wet?');assert(await textarea.evaluate(e=>document.activeElement===e));assert.equal(await page.evaluate(()=>window.panel.agent.state.messages.length),0);
  assert(await page.getByRole('button',{name:'How does crop rotation help the soil?',exact:true}).isDisabled());
  assert.equal(await page.evaluate(()=>document.querySelector('message-editor').insertSuggestion('must not replace draft')),false);
  assert.equal(await textarea.inputValue(),'Why is my compost staying wet?');
  await page.evaluate(()=>window.failSend=true);await textarea.press('Enter');await page.getByRole('alert').waitFor();assert.equal(await textarea.inputValue(),'Why is my compost staying wet?');assert.equal(await page.locator('.cw-onboarding').count(),1);
  await page.evaluate(()=>window.failSend=false);await textarea.press('Enter');await page.locator('.cw-onboarding').waitFor({state:'detached'});
  await page.getByTitle('New Chat',{exact:true}).click();await page.locator('.cw-onboarding').waitFor();assert.equal(await textarea.inputValue(),'');assert.equal(await page.locator('[data-editor-controls] button').count(),3);
  await page.evaluate(()=>window.load([{role:'user',content:'Existing question',timestamp:1}]));assert.equal(await page.locator('.cw-onboarding').count(),0,'saved conversation has no introduction');
  await page.evaluate(()=>window.load([{role:'memory-context',content:'injected context'}]));assert.equal(await page.locator('.cw-onboarding').count(),1,'memory alone does not hide the introduction');
  await page.evaluate(()=>window.load([{role:'voice-pending',timestamp:new Date().toISOString()}]));assert.equal(await page.locator('.cw-onboarding').count(),0,'recording hides introduction');
  await page.getByTitle('New Chat',{exact:true}).click();await page.getByTitle('Replay quick start',{exact:true}).click();
  for(let step=0;step<6;step++){
   const bounds=await page.locator('dialog[open]').boundingBox();assert(bounds.x>=0&&bounds.y>=0&&bounds.x+bounds.width<=viewport.width+1&&bounds.y+bounds.height<=viewport.height+1);
   assert(await page.locator('dialog[open]').evaluate(e=>document.activeElement===e.querySelector('h2')),'each new instruction receives accessible focus');
   await page.getByRole('button',{name:step===5?'Ready':'Next',exact:true}).click();
  }
  await page.getByRole('button',{name:'About',exact:true}).click();await page.screenshot({path:out+'/'+name+'-about.png',fullPage:true});
  assert.match(await page.locator('#about').textContent(),/Local AI for self-reliance and homesteading/);
  await page.locator('#about').evaluate(e=>e.scrollTop=e.scrollHeight);await page.screenshot({path:out+'/'+name+'-about-library.png'});
  await page.getByTitle('Replay quick start',{exact:true}).click();assert.equal(await page.locator('dialog[open]').count(),1,'replay returns from About to anchored chat');
  await page.setViewportSize({width:320,height:300});await page.getByRole('button',{name:'Next',exact:true}).click();
  const short=await page.locator('dialog[open]').boundingBox();assert(short.y>=0&&short.y+short.height<=301,'short viewport contains tour');await page.getByRole('button',{name:'Skip tour',exact:true}).click();
  assert.equal(await page.evaluate(()=>window.micCalls),0);assert.deepEqual(errors,[]);await page.close();
 }
 console.log('Onboarding/tour passed desktop, mobile and short viewport; screenshots '+out);
}finally{await browser?.close();await server.close()}
