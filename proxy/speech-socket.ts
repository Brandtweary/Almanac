import type {Server, ServerWebSocket} from "bun";
export interface SpeechSocket { upstreamUrl: string; upstream?: WebSocket; timer?: ReturnType<typeof setTimeout>; pending: (string | Uint8Array)[]; pendingBytes: number; released: boolean }
/** Only synthesis options understood by the browser protocol cross this boundary. */
export function speechUpstreamUrl(base: string, requestUrl: string): string {
 const target = new URL(base), incoming = new URL(requestUrl);
 for (const [key, value] of incoming.searchParams) {
  if (!["voice", "format", "cfg_alpha", "auth_id"].includes(key) || incoming.searchParams.getAll(key).length !== 1) throw new Error("unsupported speech option");
  if (key === "voice" && (!value || value.length > 256 || /[\x00-\x1f\x7f]/.test(value))) throw new Error("invalid voice");
  if (key === "format" && value !== "PcmMessagePack") throw new Error("unsupported speech format");
  if (key === "cfg_alpha" && (!value.trim() || !Number.isFinite(Number(value)) || Number(value) < 0)) throw new Error("invalid speech guidance");
  // Client credentials never replace server-owned backend authentication.
  if (key !== "auth_id") target.searchParams.set(key, value);
 }
 return target.href;
}
export interface SpeechBridgeDependencies {
 connect: (url: string) => WebSocket;
 schedule: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
 cancelTimer: (timer: ReturnType<typeof setTimeout> | undefined) => void;
}
/** A socket owns capacity until close/cancellation or stalled transport, never total narration age. */
export function speechBridge(url: string, capacity: number, idleTimeoutMs: number, maxBytes: number,
 dependencies: Partial<SpeechBridgeDependencies> = {}) {
 const connect = dependencies.connect ?? (url => new WebSocket(url));
 const schedule = dependencies.schedule ?? ((callback, delay) => setTimeout(callback, delay));
 const cancelTimer = dependencies.cancelTimer ?? (timer => clearTimeout(timer));
 let active = 0;
 const release = (ws: ServerWebSocket<SpeechSocket>) => {
  if (ws.data.released) return;
  ws.data.released = true; cancelTimer(ws.data.timer); active--; ws.data.pending = []; ws.data.pendingBytes = 0;
  ws.data.upstream?.close();
 };
 const close = (ws: ServerWebSocket<SpeechSocket>, code: number, reason: string) => {
  if (ws.data.released) return;
  release(ws); ws.close(code, reason);
 };
 const progress = (ws: ServerWebSocket<SpeechSocket>) => {
  if (ws.data.released) return;
  cancelTimer(ws.data.timer);
  ws.data.timer = schedule(() => close(ws, 1011, "speech inactivity timeout"), idleTimeoutMs);
 };
 return {
  upgrade(request: Request, server: Server<SpeechSocket>) {
   if (!url || capacity < 1) return Response.json({error:{code:"speech_unavailable"}}, {status:503});
   if (active >= capacity) return Response.json({error:{code:"speech_busy"}}, {status:429});
   let upstreamUrl: string;
   try { upstreamUrl = speechUpstreamUrl(url, request.url); } catch { return Response.json({error:{code:"invalid_speech_options"}}, {status:400}); }
   active++;
   if (server.upgrade(request, {data:{upstreamUrl,pending:[],pendingBytes:0,released:false}})) return undefined;
   active--; return Response.json({error:{code:"speech_upgrade_failed"}}, {status:400});
  },
  websocket: {
   open(ws: ServerWebSocket<SpeechSocket>) {
    if (ws.data.released) return;
    try {
     const upstream = connect(ws.data.upstreamUrl); upstream.binaryType = "arraybuffer"; ws.data.upstream = upstream;
     progress(ws);
     upstream.onopen = () => {
      if (ws.data.released) return;
      try { for(const message of ws.data.pending) upstream.send(message); ws.data.pending=[]; ws.data.pendingBytes=0; progress(ws); }
      catch { close(ws, 1011, "speech backend send failed"); }
     };
     upstream.onmessage = event => {
      if (ws.data.released) return;
      try {
       if(ws.send(event.data) === -1) close(ws, 1011, "speech backpressure");
       else progress(ws);
      } catch { close(ws, 1011, "speech client send failed"); }
     };
     upstream.onerror = () => close(ws, 1011, "speech backend failed");
     upstream.onclose = event => close(ws, event.code === 1000 ? 1000 : 1011, event.code === 1000 ? "speech ended" : "speech backend closed unexpectedly");
    } catch { close(ws, 1011, "speech backend connection failed"); }
   },
   message(ws: ServerWebSocket<SpeechSocket>, message: string | Buffer) {
    if (ws.data.released) return;
    const size = typeof message === "string" ? Buffer.byteLength(message) : message.byteLength;
    if(size > maxBytes || ws.data.pendingBytes + size > maxBytes) { close(ws, 1009, "speech input too large"); return; }
    try {
     if(ws.data.upstream?.readyState === WebSocket.OPEN) { ws.data.upstream.send(message); if (size > 0) progress(ws); }
     else { ws.data.pending.push(typeof message === "string" ? message : new Uint8Array(message)); ws.data.pendingBytes+=size; }
    } catch { close(ws, 1011, "speech backend send failed"); }
   },
   close(ws: ServerWebSocket<SpeechSocket>) { release(ws); },
  },
 };
}
