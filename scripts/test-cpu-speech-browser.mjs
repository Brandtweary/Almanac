// Explicit live integration: the caller supplies an already-running speech endpoint.
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {chromium} from 'playwright';
import {execFileSync} from 'node:child_process';
const endpoint=process.argv[2];if(!endpoint)throw Error('Pass a live ws://.../api/tts_streaming endpoint');
const bundle=await build({stdin:{contents:`import {KyutaiTtsSynthesizer} from './src/tts.ts';window.Synth=KyutaiTtsSynthesizer;`,resolveDir:process.cwd(),loader:'ts'},bundle:true,platform:'browser',format:'iife',define:{'import.meta.env':'{}'},write:false,logLevel:'silent'});
const browser=await chromium.launch({executablePath:process.env.BROWSER_EXECUTABLE||execFileSync('which',['brave'],{encoding:'utf8'}).trim(),headless:true});
try {
 const page=await browser.newPage();
 const url=new URL(endpoint);url.protocol='http:';url.pathname='/health';
 await page.goto(url.href);
 await page.addScriptTag({content:bundle.outputFiles[0].text});
 const result=await page.evaluate(async endpoint=>{
   const started=performance.now();let first=null,frames=0,samples=0,unavailable=false;
   const synth=new window.Synth({port:{postMessage(message){if(message.type==='audio'){first??=performance.now()-started;frames++;samples+=message.frame.length;}}}},{baseUrl:endpoint,onVoiceUnavailable(){unavailable=true;}});
   await synth.speak('The garden receives morning sunlight.');
   const elapsed=performance.now()-started;
   synth.dispose();
   return {first_audio_ms:first,elapsed_ms:elapsed,frames,samples,unavailable};
 },endpoint);
 assert.ok(result.frames>0 && result.samples>0);assert.equal(result.unavailable,false);assert.ok(result.first_audio_ms<2000);
 const cancelled=await page.evaluate(async endpoint=>{
   let synth,first=false,resets=0,unavailable=false;
   synth=new window.Synth({port:{postMessage(message){if(message.type==='reset')resets++;if(message.type==='audio'&&!first){first=true;synth.stop();}}}},{baseUrl:endpoint,onVoiceUnavailable(){unavailable=true;}});
   await synth.speak('A careful comparison keeps the conclusion proportional to the evidence. '.repeat(12));
   window.reuseSynth=synth;
   return {first,resets,unavailable};
 },endpoint);
 assert.equal(cancelled.first,true);assert.ok(cancelled.resets>0);assert.equal(cancelled.unavailable,false);
 const health=process.argv[3]??url.href;
 const deadline=Date.now()+5000;
 while(true){const state=await (await fetch(health)).json();assert.equal(state.engine,'pocket-tts');if(!state.busy)break;if(Date.now()>deadline)throw Error('Cancelled speech retained admission');await new Promise(resolve=>setTimeout(resolve,20));}
 const reused=await page.evaluate(async endpoint=>{
   let frames=0,unavailable=false;
   const synth=new window.Synth({port:{postMessage(message){if(message.type==='audio')frames++;}}},{baseUrl:endpoint,onVoiceUnavailable(){unavailable=true;}});
   await synth.speak('Speech is available again after cancellation.');synth.dispose();window.reuseSynth.dispose();
   return {frames,unavailable};
 },endpoint);
 assert.ok(reused.frames>0);assert.equal(reused.unavailable,false);
 console.log(JSON.stringify({browserSpeech:result,cancelled,reused}));
}finally{await browser.close();}
