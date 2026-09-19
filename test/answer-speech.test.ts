import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { answerSpeechState, installAnswerSpeech, resetAnswerSpeech, subscribeAnswerSpeech, toggleAnswerSpeech } from '../src/answer-speech.js';

afterEach(() => resetAnswerSpeech());

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

function fakePort(overrides: { muted?: boolean; turnSpeaking?: boolean } = {}) {
 const port = {
  spoken: [] as string[], stops: 0, muted: overrides.muted ?? false, turnSpeaking: overrides.turnSpeaking ?? false,
  generating: false, draining: false,
  resolve: undefined as undefined | (() => void), reject: undefined as undefined | ((error: Error) => void),
  speak(text: string) {
   port.spoken.push(text); port.generating = true;
   return new Promise<void>((resolve, reject) => {
    port.resolve = () => { port.generating = false; resolve(); };
    port.reject = (error: Error) => { port.generating = false; reject(error); };
   });
  },
  stop() { port.stops++; port.generating = false; port.draining = false; },
  isSpeaking: () => port.generating || port.draining,
  isMuted: () => port.muted,
  isTurnSpeaking: () => port.turnSpeaking,
 };
 installAnswerSpeech(port);
 return port;
}

test('a reading is admitted only when nothing else owns the speaker', async () => {
 assert.equal(answerSpeechState('a'), 'unavailable');
 const port = fakePort();
 const seen: string[] = [];
 subscribeAnswerSpeech(() => seen.push(answerSpeechState('a')));

 assert.equal(answerSpeechState('a'), 'idle');
 toggleAnswerSpeech('a', 'The answer.');
 assert.deepEqual(port.spoken, ['The answer.']);
 assert.equal(answerSpeechState('a'), 'speaking');
 assert.equal(answerSpeechState('b'), 'busy', 'one reading at a time across answers');
 assert.deepEqual(seen, ['speaking']);

 // Clicking the speaking control stops it, matching the stop-audio control's single-click cut.
 toggleAnswerSpeech('a', 'The answer.');
 assert.equal(port.stops, 1);
 assert.equal(answerSpeechState('a'), 'idle');
 assert.deepEqual(port.spoken, ['The answer.'], 'stopping never starts a second utterance');
 port.resolve!();
});

test('a muted session, a live turn and draining audio all leave the control inert', async () => {
 const port = fakePort({ muted: true });
 assert.equal(answerSpeechState('a'), 'muted');
 toggleAnswerSpeech('a', 'The answer.');
 assert.deepEqual(port.spoken, [], 'a muted session never starts speaking from a click');

 port.muted = false;
 port.turnSpeaking = true;
 assert.equal(answerSpeechState('a'), 'busy');
 toggleAnswerSpeech('a', 'The answer.');
 assert.deepEqual(port.spoken, [], "a click never cuts the agent's own playback");

 port.turnSpeaking = false;
 port.draining = true;
 assert.equal(answerSpeechState('a'), 'busy', 'a turn tail still draining still owns the speaker');
 toggleAnswerSpeech('a', 'The answer.');
 assert.deepEqual(port.spoken, []);

 port.draining = false;
 toggleAnswerSpeech('a', '   ');
 assert.deepEqual(port.spoken, [], 'an answer with no speakable text is not an utterance');
 toggleAnswerSpeech('a', 'The answer.');
 assert.deepEqual(port.spoken, ['The answer.']);
 port.resolve!();
});

test('the control returns to idle only once the audio it started has drained', async () => {
 const port = fakePort();
 toggleAnswerSpeech('a', 'The answer.');
 port.draining = true;
 port.resolve!();
 await sleep(60);
 assert.equal(answerSpeechState('a'), 'speaking', 'generation ends ahead of playback');
 port.draining = false;
 await sleep(400);
 assert.equal(answerSpeechState('a'), 'idle');

 // A synthesis failure releases the control rather than stranding it.
 toggleAnswerSpeech('a', 'The answer.');
 assert.equal(answerSpeechState('a'), 'speaking');
 port.reject!(new Error('tts unreachable'));
 await sleep(60);
 assert.equal(answerSpeechState('a'), 'idle');
});
