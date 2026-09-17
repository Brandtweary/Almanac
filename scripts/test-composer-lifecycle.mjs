import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {chromium} from 'playwright';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
const root=fileURLToPath(new URL('../',import.meta.url));
const executablePath=process.env.BROWSER_EXECUTABLE || execFileSync('which',['brave'],{encoding:'utf8'}).trim();
const main=ts.createSourceFile('main.ts',readFileSync(new URL('../src/main.ts',import.meta.url),'utf8'),ts.ScriptTarget.Latest,true);
let recovery='';
function find(node){if(ts.isVariableDeclaration(node)&&node.name.getText(main)==='showVoiceToast')recovery=node.initializer.getText(main);ts.forEachChild(node,find);}
find(main);assert.ok(recovery);
const bundle=await build({stdin:{contents:`
window.showRecovered=${recovery};
import {ChatPanel} from './src/pi-web-ui/ChatPanel.ts';
import {VoiceController} from './src/voice.ts';
import {MemoryButton} from './src/memory-button.ts';
import {StopAudioButton} from './src/stop-audio-button.ts';
import {setAppStorage} from './src/pi-web-ui/storage/app-storage.ts';
setAppStorage({providerKeys:{get:async()=> 'local'}});
const agent=()=>({state:{model:{id:'fixture',provider:'fixture',reasoning:false},messages:[],tools:[],isStreaming:false,pendingToolCalls:new Set(),thinkingLevel:'off'},subscribe:()=>()=>{},streamFn:()=>{},getApiKey:()=> 'local',prompt:async()=>{throw new Error('Context measurement unavailable');}});
window.setup=async()=>{const panel=new ChatPanel();document.body.append(panel);await panel.setAgent(agent());await panel.updateComplete;await panel.agentInterface.updateComplete;await panel.querySelector('message-editor').updateComplete;window.panel=panel;window.controls=[new VoiceController({}),new MemoryButton({getVisual:()=> 'off',onClick:()=>{}}),new StopAudioButton({isMuted:()=>false,onCut:()=>{},onToggleMute:()=>{}})];};
window.replace=async()=>{await window.panel.setAgent(agent());await window.panel.updateComplete;await window.panel.agentInterface.updateComplete;await window.panel.querySelector('message-editor').updateComplete;};
`,resolveDir:root,loader:'ts'},bundle:true,format:'iife',platform:'browser',define:{'import.meta.env':'{}','import.meta.url':'"https://fixture.invalid/"'},write:false,logLevel:'silent',plugins:[{name:'attachment-fixture',setup(builder){builder.onResolve({filter:/attachment-utils\.js$/},()=>({path:'attachment-utils',namespace:'fixture'}));builder.onLoad({filter:/.*/,namespace:'fixture'},()=>({contents:'export async function loadAttachment(){throw new Error("Attachments not requested in this fixture");}',loader:'js'}));}}]});
const browser=await chromium.launch({executablePath,headless:true});
try{
 const page=await browser.newPage();const errors=[];page.on('pageerror',error=>errors.push(error.message));
 await page.route('**/*',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><html><body></body></html>'}));
 await page.goto('https://fixture.invalid/');
 await page.addScriptTag({content:bundle.outputFiles[0].text});await page.evaluate(()=>window.setup());
 for(let i=0;i<3;i++){
  assert.equal(await page.locator('message-editor .cw-stop, message-editor .cw-mem, message-editor .cw-mic').count(),3);
  assert.deepEqual(await page.locator('[data-editor-controls] button').evaluateAll(buttons=>buttons.map(button=>button.className.split(' ')[0])),['cw-stop','cw-mem','cw-mic']);
  await page.evaluate(async()=>{const editor=document.querySelector('message-editor');editor.isStreaming=true;await editor.updateComplete;editor.isStreaming=false;await editor.updateComplete;});
  assert.equal(await page.locator('[data-editor-controls] button').count(),3,'Send/Stop swap preserves controls');
  await page.evaluate(()=>window.replace());
 }
 await page.locator('message-editor textarea').fill('preserved draft');
 await page.locator('message-editor textarea').press('Enter');
 await page.getByRole('alert').waitFor();
 assert.match(await page.getByRole('alert').innerText(),/Context measurement unavailable/);
 assert.equal(await page.locator('message-editor textarea').inputValue(),'preserved draft');
 assert.deepEqual(errors,[],'rejected sends do not leak unhandled errors');
 const scheduled=await page.evaluate(()=>{const original=window.setTimeout;let calls=0;window.setTimeout=()=>{calls++;return 0;};try{window.showRecovered('Copy before dismissing.','recognized speech from another conversation');}finally{window.setTimeout=original;}return calls;});
 assert.equal(scheduled,0,'recovery transcript never expires automatically');
 assert.equal(await page.getByLabel('Unsent voice transcript').inputValue(),'recognized speech from another conversation');
 assert.equal(await page.locator('message-editor textarea').inputValue(),'preserved draft','recovery surface does not overwrite another conversation');
 await page.getByRole('button',{name:'Dismiss transcript'}).click();
 assert.equal(await page.getByLabel('Unsent voice transcript').count(),0);
 await page.evaluate(()=>window.controls.forEach(control=>control.destroy()));
 assert.equal(await page.locator('[data-editor-controls] button').count(),0);
 console.log('Real composer replacement, Send/Stop lifecycle and rejected draft checks passed');
}finally{await browser.close();}
