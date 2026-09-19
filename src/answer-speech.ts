/**
 * Reading one answer aloud on demand, outside the voice turn that produced it.
 *
 * The turn speaker is opened by the agent lifecycle and holds the single synthesizer for the
 * whole turn, so an on-demand reading is admitted only while nothing else owns playback: a
 * second utterance would supersede the first mid-sentence. The synthesizer is also the only
 * thing that knows the reading has finished, so state transitions are published here and the
 * controls re-read them rather than each holding its own copy.
 */

/** The capabilities the application layer owns; the control itself reaches none of them. */
export interface AnswerSpeechPort {
	/** Synthesize a complete answer through the one-shot path, resolving when generation ends. */
	speak(text: string): Promise<void>;
	/** Cut playback immediately, the same cut the stop-audio control performs. */
	stop(): void;
	/** Whether audio from this port is still being generated or released. */
	isSpeaking(): boolean;
	/** The persistent speak-but-don't-listen mute. */
	isMuted(): boolean;
	/** Whether the agent's own turn playback owns the speaker right now. */
	isTurnSpeaking(): boolean;
}

export type AnswerSpeechState = "unavailable" | "muted" | "busy" | "speaking" | "idle";

let port: AnswerSpeechPort | undefined;
let active: string | undefined;
const listeners = new Set<() => void>();

/** Republish state to every mounted control; also called by the voice lifecycle in the host. */
export function refreshAnswerSpeech(): void {
	for (const listener of listeners) listener();
}

export function installAnswerSpeech(installed: AnswerSpeechPort): void {
	port = installed;
	refreshAnswerSpeech();
}

/**
 * Publish now and again once the speaker falls silent. A turn that ends still has paced frames
 * draining, and nothing else reports the moment they run out.
 */
export function refreshAnswerSpeechUntilSilent(): void {
	refreshAnswerSpeech();
	if (port) waitForSilence(port, refreshAnswerSpeech);
}

export function subscribeAnswerSpeech(listener: () => void): () => void {
	listeners.add(listener);
	return () => { listeners.delete(listener); };
}

export function answerSpeechState(key: string): AnswerSpeechState {
	if (!port) return "unavailable";
	if (active === key) return "speaking";
	if (port.isMuted()) return "muted";
	if (active !== undefined || port.isTurnSpeaking() || port.isSpeaking()) return "busy";
	return "idle";
}

/**
 * Idle starts a reading, and a reading in progress is stopped by the same control, matching the
 * stop-audio button's single-click cut. Every other state is inert: a click during the agent's
 * own playback would cut the answer being spoken to start the same words again.
 */
export function toggleAnswerSpeech(key: string, text: string): void {
	const speaker = port;
	if (!speaker) return;
	const state = answerSpeechState(key);
	if (state === "speaking") {
		speaker.stop();
		active = undefined;
		refreshAnswerSpeech();
		return;
	}
	if (state !== "idle" || !text.trim()) return;
	active = key;
	refreshAnswerSpeech();
	const release = () => {
		if (active !== key) return;
		active = undefined;
		refreshAnswerSpeech();
	};
	speaker.speak(text).then(
		// Generation finishes ahead of playback: the paced frames are still draining, and a
		// control returned to idle there would admit an utterance that cuts its own tail.
		() => waitForSilence(speaker, release),
		() => release(),
	);
}

const SILENCE_POLL_MS = 150;

function waitForSilence(speaker: AnswerSpeechPort, done: () => void): void {
	if (!speaker.isSpeaking()) { done(); return; }
	const timer = setInterval(() => {
		if (speaker.isSpeaking()) return;
		clearInterval(timer);
		done();
	}, SILENCE_POLL_MS);
}

/** Test seam: drop the installed port and any reading it owns. */
export function resetAnswerSpeech(): void {
	port = undefined;
	active = undefined;
	listeners.clear();
}
