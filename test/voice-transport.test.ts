import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { PcmRecorder, WhisperClient } from '../src/stt.js';
import { KyutaiTtsSynthesizer } from '../src/tts.js';

const original = { fetch: globalThis.fetch, AudioContext: globalThis.AudioContext, AudioWorkletNode: globalThis.AudioWorkletNode, WebSocket: globalThis.WebSocket };
afterEach(() => Object.assign(globalThis, original));

function deferred<T = void>() {
 let resolve!: (value: T) => void;
 const promise = new Promise<T>(r => { resolve = r; });
 return { promise, resolve };
}

test('invalid successful STT responses are errors; actual empty speech remains valid', async () => {
 const client = new WhisperClient({url: 'http://test.invalid'});
 for (const body of [{}, [], null, {text: 12}]) {
  globalThis.fetch = async () => new Response(JSON.stringify(body));
  await assert.rejects(client.transcribe(new Float32Array(2)), /invalid response/);
 }
 globalThis.fetch = async () => new Response('{"text":"  "}');
 assert.equal(await client.transcribe(new Float32Array(2)), '');
});

test('cancel during worklet initialization cannot resurrect recording or close a newer context', async () => {
 const moduleReady = deferred();
 const contexts: FakeContext[] = [];
 class FakeContext {
  state = 'running'; sampleRate = 48000; destination = {}; loaded = false; sources = 0;
  audioWorklet = { addModule: async () => { await moduleReady.promise; this.loaded = true; } };
  constructor() { contexts.push(this); }
  close() { this.state = 'closed'; return Promise.resolve(); }
  resume() { return Promise.resolve(); }
  createMediaStreamSource() { this.sources++; return {connect() {}, disconnect() {}}; }
 }
 class FakeWorklet {
  port = {onmessage: null};
  constructor(context: FakeContext) { if (!context.loaded) throw Error('module missing'); }
  connect() {} disconnect() {}
 }
 Object.assign(globalThis, {AudioContext: FakeContext, AudioWorkletNode: FakeWorklet});
 let stops = 0;
 const stream = {getTracks: () => [{stop() { stops++; }}]} as unknown as MediaStream;
 const recorder = new PcmRecorder({stream});
 const first = recorder.start();
 await Promise.resolve();
 assert.equal((await recorder.stop()).length, 0);
 const second = recorder.start();
 await Promise.resolve();
 moduleReady.resolve();
 await Promise.all([first, second]);
 assert.equal(contexts[0].state, 'closed');
 assert.equal(contexts[0].sources, 0);
 assert.equal(contexts[1].state, 'running');
 assert.equal(contexts[1].sources, 1);
 await recorder.stop();
 assert.equal(contexts[1].state, 'closed');
 assert.equal(stops, 0, 'borrowed stream remains caller owned');
});

test('total socket outage reports unavailable once, without real network access', async () => {
 class ClosedSocket {
  static OPEN = 1; static CONNECTING = 0; static CLOSING = 2; static CLOSED = 3;
  readyState = 3; binaryType = ''; onmessage = null; onerror = null;
  addEventListener() {} close() {}
 }
 Object.assign(globalThis, {WebSocket: ClosedSocket});
 let notices = 0;
 const synth = new KyutaiTtsSynthesizer({port: {postMessage() {}}} as unknown as AudioWorkletNode, {
  onVoiceUnavailable: () => { notices++; },
 });
 await synth.speak('A useful answer.');
 await synth.speak('Another useful answer.');
 assert.equal(notices, 1);
 synth.dispose();
});

test('speaker ownership is reported while an utterance runs and released by a cut', async () => {
 class ClosedSocket {
  static OPEN = 1; static CONNECTING = 0; static CLOSING = 2; static CLOSED = 3;
  readyState = 3; binaryType = ''; onmessage = null; onerror = null;
  addEventListener() {} close() {}
 }
 Object.assign(globalThis, {WebSocket: ClosedSocket});
 const synth = new KyutaiTtsSynthesizer({port: {postMessage() {}}} as unknown as AudioWorkletNode, {});
 assert.equal(synth.isSpeaking(), false);
 const utterance = synth.speak('A useful answer.');
 assert.equal(synth.isSpeaking(), true, 'a running utterance owns the speaker');
 synth.stop();
 assert.equal(synth.isSpeaking(), false, 'a cut releases it immediately');
 await utterance;
 assert.equal(synth.isSpeaking(), false, 'a superseded run never re-reports ownership');
 const second = synth.speak('Another useful answer.');
 assert.equal(synth.isSpeaking(), true);
 await second;
 assert.equal(synth.isSpeaking(), false, 'a finished utterance releases the speaker');
 synth.dispose();
});

test('cancel while microphone permission is pending releases the late stream', async () => {
 const {VoiceController} = await import('../src/voice.js');
 const permission = deferred<MediaStream>();
 const oldNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
 let stops = 0, starts = 0;
 const controller = Object.create(VoiceController.prototype) as any;
 Object.assign(controller, {state: 'idle', generation: 0, seam: {onStart() {starts++;}}, setState(state: string) {this.state = state;}});
 Object.defineProperty(globalThis, 'navigator', {configurable: true, value: {mediaDevices: {getUserMedia: () => permission.promise}}});
 try {
  const pending = controller.start();
  controller.cancel();
  permission.resolve({getTracks: () => [{stop() {stops++;}}]} as unknown as MediaStream);
  await pending;
  assert.equal(starts, 0);
  assert.equal(stops, 1);
  assert.equal(controller.state, 'idle');
 } finally {
  if (oldNavigator) Object.defineProperty(globalThis, 'navigator', oldNavigator);
  else Reflect.deleteProperty(globalThis, 'navigator');
 }
});

test('dispose releases owned playback resources once and rejects reuse', async () => {
 let disposals = 0;
 const synth = new KyutaiTtsSynthesizer({port: {postMessage() {}}} as unknown as AudioWorkletNode, {
  onDispose: () => {disposals++;},
 });
 synth.dispose();
 synth.dispose();
 assert.equal(disposals, 1);
 await assert.rejects(synth.speak('Stale speech.'), /disposed/);
});
