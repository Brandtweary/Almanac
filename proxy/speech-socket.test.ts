import {test, expect} from "bun:test";
import {speechBridge, type SpeechSocket} from "./speech-socket";
test("speech websocket admission is bounded and close releases exactly once", () => {
 const bridge = speechBridge("ws://speech.invalid", 1, 1000, 1024);
 let data: SpeechSocket;
 const server = {upgrade(_r: Request, options: {data: SpeechSocket}) {data=options.data;return true;}} as any;
 const request = new Request("http://local.invalid/api/tts_streaming");
 expect(bridge.upgrade(request,server)).toBeUndefined();
 expect(bridge.upgrade(request,server)?.status).toBe(429);
 const ws = {data:data!} as any;
 bridge.websocket.close(ws); bridge.websocket.close(ws);
 expect(bridge.upgrade(request,server)).toBeUndefined();
 expect(bridge.upgrade(request,server)?.status).toBe(429);
 bridge.websocket.close({data:data!} as any);
});
test("failed upgrade returns its capacity and unconfigured speech fails explicitly", () => {
 const bridge = speechBridge("ws://speech.invalid", 1, 1000, 1024);
 const request = new Request("http://local.invalid/api/tts_streaming");
 expect(bridge.upgrade(request,{upgrade:()=>false} as any)?.status).toBe(400);
 expect(bridge.upgrade(request,{upgrade:()=>false} as any)?.status).toBe(400);
 expect(speechBridge("",0,1000,1024).upgrade(request,{} as any)?.status).toBe(503);
});
test("synthesis options survive upgrade without overriding backend auth",()=>{
 const bridge=speechBridge("ws://speech.invalid/api/tts_streaming?auth_id=server",1,1000,1024);
 let data: SpeechSocket;
 const server={upgrade(_r:Request,o:{data:SpeechSocket}){data=o.data;return true;}} as any;
 expect(bridge.upgrade(new Request("http://site.invalid/almanac/api/tts_streaming?voice=leah&format=PcmMessagePack&cfg_alpha=1.5&auth_id=public_token"),server)).toBeUndefined();
 const url=new URL(data!.upstreamUrl); expect(url.searchParams.get("voice")).toBe("leah"); expect(url.searchParams.get("cfg_alpha")).toBe("1.5"); expect(url.searchParams.get("format")).toBe("PcmMessagePack"); expect(url.searchParams.get("auth_id")).toBe("server");
 bridge.websocket.close({data:data!} as any);
 for(const query of ["voice=one&voice=two","format=Opus","cfg_alpha=NaN","url=http://other.invalid"])
  expect(bridge.upgrade(new Request(`http://site.invalid/api/tts_streaming?${query}`),server)?.status).toBe(400);
});
function streamingFixture() {
 let now = 0, next = 1;
 const timers = new Map<number, {at: number; callback: () => void}>();
 const upstream = {readyState: 0, binaryType: "", onopen: null as any, onmessage: null as any, onerror: null as any, onclose: null as any, closes: 0, sent: [] as unknown[],
  send(value: unknown) {this.sent.push(value);}, close() {this.closes++;}};
 const bridge=speechBridge("ws://speech.invalid",1,60_000,1024,{
  connect:()=>upstream as unknown as WebSocket,
  schedule:(callback,delay)=>{const id=next++;timers.set(id,{at:now+delay,callback});return id as any;},
  cancelTimer:timer=>{timers.delete(timer as unknown as number);},
 });
 let data: SpeechSocket;
 const request=new Request("http://site.invalid/api/tts_streaming");
 const server={upgrade(_r:Request,o:{data:SpeechSocket}){data=o.data;return true;}} as any;
 bridge.upgrade(request,server);
 const closes:{code:number;reason:string}[]=[];const received:unknown[]=[];
 const ws={data:data!,send:(value:unknown)=>{received.push(value);return 1;},close:(code:number,reason:string)=>closes.push({code,reason})} as any;
 bridge.websocket.open(ws);
 const advance=(ms:number)=>{now+=ms;for(const [id,timer] of [...timers])if(timer.at<=now){timers.delete(id);timer.callback();}};
 const ready=()=>{upstream.readyState=WebSocket.OPEN;upstream.onopen();};
 return {bridge,upstream,request,server,ws,closes,received,advance,ready,timers};
}
test("productive narration outlives repeated inactivity windows, a stalled stream expires",()=>{
 const f=streamingFixture();f.ready();
 for(let i=0;i<12;i++) {f.advance(30_000);f.upstream.onmessage({data:new Uint8Array([i])});}
 expect(f.received).toHaveLength(12);expect(f.closes).toHaveLength(0);
 expect(f.bridge.upgrade(f.request,f.server)?.status).toBe(429);
 f.advance(60_001);expect(f.closes).toEqual([{code:1011,reason:"speech inactivity timeout"}]);expect(f.upstream.closes).toBe(1);
 expect(f.bridge.upgrade(f.request,f.server)).toBeUndefined();
});
test("queued input cannot keep an unconnected backend alive",()=>{
 const f=streamingFixture();
 f.advance(30_000);f.bridge.websocket.message(f.ws,"sentence");
 f.advance(30_001);expect(f.closes[0]?.reason).toBe("speech inactivity timeout");expect(f.upstream.sent).toHaveLength(0);
});
test("forwarded text counts as transport progress and client cancellation releases immediately",()=>{
 const f=streamingFixture();f.ready();f.advance(50_000);f.bridge.websocket.message(f.ws,"sentence");f.advance(50_000);
 expect(f.closes).toHaveLength(0);expect(f.upstream.sent).toEqual(["sentence"]);
 f.bridge.websocket.close(f.ws);expect(f.timers.size).toBe(0);expect(f.upstream.closes).toBe(1);
 f.upstream.onmessage({data:new Uint8Array([1])});f.advance(500_000);expect(f.received).toHaveLength(0);expect(f.closes).toHaveLength(0);
 expect(f.bridge.upgrade(f.request,f.server)).toBeUndefined();
 f.bridge.websocket.close(f.ws);expect(f.bridge.upgrade(f.request,f.server)?.status).toBe(429);
});
