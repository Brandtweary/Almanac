import {test,expect} from "bun:test";
import {waitForSpeechEnd} from "../src/tts-idle";
test("browser completion waits through productive audio and cleans its listener on cancellation",async()=>{
 let now=0,id=0;const timers=new Map<number,{at:number;fn:()=>void}>();let closes=0,finish!:()=>void;
 const target=new EventTarget();const socket={addEventListener:target.addEventListener.bind(target),removeEventListener:target.removeEventListener.bind(target),close:()=>closes++};
 const clock={set:(fn:()=>void,ms:number)=>{timers.set(++id,{at:now+ms,fn});return id as any;},clear:(n:any)=>{timers.delete(n);}};
 const advance=(ms:number)=>{now+=ms;for(const [i,t] of [...timers])if(t.at<=now){timers.delete(i);t.fn();}};
 const waiting=waitForSpeechEnd(socket,new Promise<void>(r=>finish=r),60_000,()=>{},clock);
 for(let i=0;i<20;i++){advance(30_000);target.dispatchEvent(new Event("message"));}
 expect(closes).toBe(0);finish();await waiting;expect(timers.size).toBe(0);
 target.dispatchEvent(new Event("message"));expect(timers.size).toBe(0);advance(100_000);expect(closes).toBe(0);
});
test("browser closes a stalled stream and resolves its sentence wait",async()=>{
 let expire!:()=>void,closes=0,timeouts=0;
 const target=new EventTarget();const waiting=waitForSpeechEnd({addEventListener:target.addEventListener.bind(target),removeEventListener:target.removeEventListener.bind(target),close:()=>closes++},new Promise(()=>{}),60_000,()=>timeouts++,{set:fn=>{expire=fn;return 1 as any;},clear:()=>{}});
 expire();await waiting;expect(closes).toBe(1);expect(timeouts).toBe(1);expire();expect(closes).toBe(1);
});
