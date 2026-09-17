import assert from 'node:assert/strict';
import {createServer} from 'vite';
import {encode,decode} from '@msgpack/msgpack';
import {SpeechTextFilter} from '../src/speech-text.ts';

function project(parts:string[]){const filter=new SpeechTextFilter();return parts.map(s=>filter.push(s)).join('')+filter.flush();}
const hash='0123456789abcdef'.repeat(4);
const cases:[string,string][]=[
 [`Use 3.14 liters, then read [Pump manual](corpus:p:${hash}:${hash}). Keep 1/4 inch clearance.`, 'Use 3.14 liters, then read Pump manual. Keep 1/4 inch clearance.'],
 ['Read [Water guide](https://example.org/manual_(v2)?page=12 "Source title"). Then wait 30 minutes.', 'Read Water guide. Then wait 30 minutes.'],
 [`[First](corpus:p:${hash}) and [Second](corpus:p:${hash}) agree: 5–10 N·m, -5 °C, 2e3 Pa.`, 'First and Second agree: 5–10 N·m, -5 °C, 2e3 Pa.'],
 [`Read [Partial label](corpus:p:${hash}`, 'Read Partial label'],
 ['Read [unfinished label', 'Read unfinished label'],
 [`Discard [source](corpus:p:${hash}\nNew message: use 12 volts.`, 'Discard source\nNew message: use 12 volts.'],
 [`Bare corpus:p:${hash}:${hash} is not speech.`, 'Bare  is not speech.'],
 ['The corpus is available. The corpus', 'The corpus is available. The corpus'],
 ['A [guide \\] revised](https://example.org/a\\)b) says 2.5%.', 'A guide ] revised says 2.5%.'],
];
for(const [input,want] of cases){
 assert.equal(project([input]),want);
 assert.equal(project([...input]),want,'single-character token boundaries');
 for(let at=0;at<=input.length;at++)assert.equal(project([input.slice(0,at),input.slice(at)]),want,`boundary ${at}`);
}
const bounded=new SpeechTextFilter();assert.equal(bounded.push('[manual]('),'manual');
for(let i=0;i<1000;i++)assert.equal(bounded.push(hash),'');
assert(JSON.stringify(bounded).length<200,'destination bytes never accumulate');assert.equal(bounded.push('). Next.'),'. Next.');

const server=await createServer({optimizeDeps:{noDiscovery:true,include:[]},server:{middlewareMode:true,hmr:false},appType:'custom'});
const original=globalThis.WebSocket;
try{
 const {chunkText,chunkStream,KyutaiTtsSynthesizer}=await server.ssrLoadModule('/src/tts.ts');
 const parts=async function*(text:string){for(const c of text)yield c;};
 const sample=cases[0][0];const want=cases[0][1];
 assert.equal(chunkText(sample).join(' '),want);
 const collected=[];for await(const s of chunkStream(parts(sample)))collected.push(s);assert.equal(collected.join(' '),want);
 let release!:()=>void;const gate=new Promise<void>(r=>release=r);
 const live=chunkStream((async function*(){yield 'Start now. ';await gate;yield sample;})())[Symbol.asyncIterator]();
 assert.deepEqual(await Promise.race([live.next(),new Promise((_,reject)=>setTimeout(()=>reject(Error('Speech waits for full answer')),500))]),{value:'Start now.',done:false});release();while(!(await live.next()).done){}
 const sent:string[]=[];
 class Socket extends EventTarget {
  static OPEN=1;static CLOSING=2;static CLOSED=3;readyState=1;binaryType='arraybuffer';onmessage:any;onerror:any;
  constructor(_url:string){super();queueMicrotask(()=>this.message({type:'Ready'}));}
  message(value:unknown){const bytes=encode(value);const event=new MessageEvent('message',{data:bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength)});this.onmessage?.(event);this.dispatchEvent(event);}
  send(bytes:Uint8Array){const value=decode(bytes) as any;if(value.type==='Text')sent.push(value.text);if(value.type==='Eos')queueMicrotask(()=>{this.message({type:'Audio',pcm:[.1]});this.close();});}
  close(){if(this.readyState===3)return;this.readyState=3;this.dispatchEvent(new Event('close'));}
 }
 globalThis.WebSocket=Socket as any;
 const synth=new KyutaiTtsSynthesizer({port:{postMessage(){}}},{baseUrl:'ws://fixture.invalid/tts'});
 try{await synth.speak(parts(sample));assert.equal(sent.join(' '),want);assert(!sent.some(s=>s.includes(hash)||s.includes('corpus:')));sent.length=0;await synth.speak(sample);assert.equal(sent.join(' '),want);}finally{synth.dispose();}
 console.log('Speech link projection: every split, partial links, bounded state, early streaming and actual TTS Text frames passed');
}finally{globalThis.WebSocket=original;await server.close();}
