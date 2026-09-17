/** Bound a stalled speech transport without imposing a lifetime on productive narration. */
export function waitForSpeechEnd(
 socket: Pick<WebSocket, "addEventListener" | "removeEventListener" | "close">,
 done: Promise<void>, idleMs: number, onTimeout: () => void,
 clock = {set: (callback: () => void, ms: number) => setTimeout(callback, ms), clear: (id: ReturnType<typeof setTimeout> | undefined) => clearTimeout(id)},
): Promise<void> {
 if (!Number.isFinite(idleMs) || idleMs <= 0) return Promise.reject(new Error("Invalid speech inactivity deadline"));
 return new Promise<void>((resolve, reject) => {
  let timer: ReturnType<typeof setTimeout> | undefined, finished = false;
  const cleanup = () => {finished = true; clock.clear(timer); socket.removeEventListener("message", progress);};
  const expire = () => {
   if (finished) return;
   cleanup();
   try {onTimeout();} finally {try {socket.close();} finally {resolve();}}
  };
  const progress = () => {if (!finished) {clock.clear(timer); timer = clock.set(expire, idleMs);}};
  socket.addEventListener("message", progress);
  progress();
  done.then(() => {cleanup(); resolve();}, error => {cleanup(); reject(error);});
 });
}
