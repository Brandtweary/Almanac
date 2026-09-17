import type { MessageEditor } from "./pi-web-ui/components/MessageEditor.js";
import { QuickStartTour } from "./quick-start-tour.js";
import { type MemoryArchiveRecord, type MemoryArchiveQuery } from "./memory-archive.js";
import { makeLexiconAsset, parseLexiconAsset, replacementPipeline, type LexiconReplacement } from "./lexicon-transfer.js";
import { emptyMaintenance } from "./glossary-maintenance.js";
import { appPath } from "./app-paths.js";
import { ConversationHistory, createConversationHistoryTool, historyWithoutPersonalMemory, type ConversationArchive } from "./conversation-history.js";
import { buildOraclePrompt } from "./oracle-prompts.js";
import { compactContext, COMPACTION_INSTRUCTIONS } from "./oracle-context.js";
import { EvidenceLedger, createCorpusTools, resolveCorpusCitation } from "./corpus-tools.js";
import { registerReferenceToolRenderers } from "./reference-tool-renderers.js";
import { createLocalStreamFn, subscribeRequests, countRequestTokens, serializeModelRequest } from "./oracle-runtime.js";
import { voiceLeaseResponse, serviceError } from "./service-contracts.js";
import { sendWithAdmission } from "./send-admission.js";
import {
	Agent,
	type AgentMessage,
} from "@earendil-works/pi-agent-core";
import type { Model, TextContent } from "@earendil-works/pi-ai";
import {
	type AgentState,
	AppStorage,
	ChatPanel,
	CustomProvidersStore,
	IndexedDBStorageBackend,
	ProviderKeysStore,
	SessionListDialog,
	SessionsStore,
	SettingsDialog,
	SettingsStore,
	setAppStorage,
} from "./pi-web-ui/index.js";
import { html, render } from "lit";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import { marked } from "marked";
import { History, Plus, Settings } from "lucide";
import "./app.css";
import { getTranslations, icon, setTranslations } from "@mariozechner/mini-lit";
import { Button } from "@mariozechner/mini-lit/dist/Button.js";
import { Input } from "@mariozechner/mini-lit/dist/Input.js";
import {
	MYRIAPOD_MODEL,
	MYRIAPOD_MODEL_ID,
	MYRIAPOD_PROXY_BASE,
	MYRIAPOD_PROXY_PROVIDER,
	MYRIAPOD_REASONING_EFFORT,
	MYRIAPOD_THINKING_LEVEL,
	proxyChatModel,
	loadReleaseProfile,
	releaseProfile,
} from "./myriapod-model.js";
import readmeDoc from "../README.md?raw";
import aboutDoc from "../about-almanac.md?raw";
import { MemoryTab } from "./settings.js";
import { dbg, dbgError, dbgWarn, installInstrumentation, summarizeMessages } from "./debug.js";
import {
	createVoicePendingMessage,
	customConvertToLlm,
	registerCustomMessageRenderers,
} from "./custom-messages.js";
import { createMemoryDumpTool, createMemorySearchTool, registerMemoryToolRenderers } from "./kg-tools.js";
import { createWebSearchTool, registerWebToolRenderer } from "./web-tools.js";
import { Graph } from "./kg/graph.js";
import { PROVISIONAL_RECALL_POLICY, StaleRecallError } from "./kg/recall-pool.js";
import { RecallSession } from "./recall-session.js";
import { makeCompletion } from "./kg/ingest.js";
import { makeEmbedClient } from "./kg/embed.js";
import { makePhonemizeClient } from "./stt-phonemize.js";
import type { GraphAsset, TermMatch } from "./kg/types.js";
import { PIPELINE_STORE, PipelineRuntime, type VoiceEvidence } from "./pipeline.js";
import { MemoryStorage, type MemorySnapshot, type MemoryUpdate } from "./memory-storage.js";
import { withoutPersonalMemory } from "./memory-state.js";
import { applyAutoReplace, emptySttLexicon } from "./stt-lexicon.js";
import { installVoiceCapture } from "./voice.js";
import { PcmRecorder, WhisperClient } from "./stt.js";
import { KyutaiTtsSynthesizer, TTS_SAMPLE_RATE } from "./tts.js";
import { type ConsentChoice, showConsentModal } from "./consent-modal.js";
import { installMemoryButton } from "./memory-button.js";
import { installStopAudioButton } from "./stop-audio-button.js";

// Register custom message + tool renderers
registerCustomMessageRenderers();
registerMemoryToolRenderers();
registerWebToolRenderer();
registerReferenceToolRenderers();

// Rename pi-web-ui's "session" vocabulary to the friendlier "chat" everywhere it
// surfaces (the SessionListDialog title etc. render via mini-lit's i18n). We
// can't edit the dependency's strings, but we can override the translations.
const baseTranslations = getTranslations();
setTranslations({
	...baseTranslations,
	en: {
		...baseTranslations.en,
		Sessions: "Chats",
		"No sessions yet": "No chats yet",
		"Delete this session?": "Delete this chat?",
		"Load a previous conversation": "Load a previous chat",
	} as typeof baseTranslations.en,
});

// Lexicon persistence: one serialized term-store blob in its own IndexedDB
// store — the user's memory across all conversations. (The pipeline's own state
// — action buffers, running context, speech-adaptation data, review flags —
// lives in the PIPELINE_STORE, keyed slots.)
const LEXICON_STORE = "lexicon";

// Memory-consent persistence: the visitor's opt-in choice, remembered per browser
// so the consent modal asks only once.
const CONSENT_STORE = "memory-consent";

// Create stores
const settings = new SettingsStore();
const providerKeys = new ProviderKeysStore();
const sessions = new SessionsStore();
const customProviders = new CustomProvidersStore();

// Gather configs
const configs = [
	settings.getConfig(),
	SessionsStore.getMetadataConfig(),
	providerKeys.getConfig(),
	customProviders.getConfig(),
	sessions.getConfig(),
	{ name: LEXICON_STORE }, // the term memory (serialized asset)
	{ name: PIPELINE_STORE }, // pipeline state: buffers, running context, STT data, flags
	{ name: CONSENT_STORE }, // memory-consent choice
];

// Create backend
const backend = new IndexedDBStorageBackend({
	dbName: "pi-web-ui-example",
	version: 5, // v5: term-based memory (lexicon + pipeline stores; the old
	// personal-graph store is abandoned — pre-launch clean wipe, no migration)
	stores: configs,
});

const memoryStorage = new MemoryStorage(backend);
let memorySnapshot: MemorySnapshot | undefined;

// Wire backend to stores
settings.setBackend(backend);
providerKeys.setBackend(backend);
customProviders.setBackend(backend);
sessions.setBackend(backend);

// Create and set app storage
const storage = new AppStorage(settings, providerKeys, sessions, customProviders, backend);
setAppStorage(storage);

// The local gateway is the sole serving path. Legacy credentials are deleted by
// key, without reading their values; saved chats and personal memory stay intact.
const MYRIAPOD_PROXY_ORIGIN = MYRIAPOD_PROXY_BASE.replace(/\/v1\/?$/, "");
async function migrateLocalAccess(): Promise<void> {
	for (const key of ["openrouter", "myriapod-family", "myriapod-anon", "myriapod"]) await providerKeys.delete(key);
}
// The auth-gated web-search endpoint, alongside the proxy's other /v1 routes
// (/v1/chat/completions etc.). Reached with the proxy principal bearer.
const WEB_SEARCH_ENDPOINT = `${MYRIAPOD_PROXY_ORIGIN}/v1/web-search`;
const EMBED_ENDPOINT = `${MYRIAPOD_PROXY_ORIGIN}/v1/embed`;

// Voice-concurrency broker (OFF by default). When VITE_VOICE_BROKER is unset the
// voice path makes no lease calls, and SttClient/KyutaiTtsSynthesizer are built with
// no URL override (they fall back to VITE_STT_BASE / VITE_TTS_BASE). Enabled, the
// broker hands each voice-engaged browser a leased TTS endpoint URL and queues
// overflow; STT is shared and never leased. The /voice/* routes
// live at the proxy ORIGIN (same as web-search), so the build-time CSP is untouched.
const VOICE_BROKER_ENABLED =
	import.meta.env.VITE_VOICE_BROKER === "1" || import.meta.env.VITE_VOICE_BROKER === "true";
const VOICE_LEASE_ENDPOINT = `${MYRIAPOD_PROXY_ORIGIN}/voice/lease`;
const VOICE_HEARTBEAT_ENDPOINT = `${MYRIAPOD_PROXY_ORIGIN}/voice/heartbeat`;
const VOICE_RELEASE_ENDPOINT = `${MYRIAPOD_PROXY_ORIGIN}/voice/release`;

type ServingPath = { model: Model<"openai-completions">; baseUrl: string; auth: string };
let servingPath: ServingPath;
async function resolveServingPath(): Promise<ServingPath> {
	await migrateLocalAccess();
	await loadReleaseProfile();
	return { model: proxyChatModel(), baseUrl: MYRIAPOD_PROXY_BASE, auth: "" };
}
const openSettings = async () => {
	SettingsDialog.open([new MemoryTab({
		isEnabled: () => memoryConsent === "granted",
		setEnabled: (on) => setMemoryConsent(on ? "granted" : "declined"),
		onExport: downloadLexicon, onImport: importLexiconFromFile, onDelete: deleteLexicon,
		hasFailedWork: () => pipeline?.hasFailedWork ?? false, retry: () => pipeline.retryPending(),
		getFlags: () => pipeline?.getFlags() ?? [], resolveFlag: (flag) => pipeline.resolveFlag(flag),
		getGlossaryDecisions: () => pipeline?.snapshot().maintenance?.decisions ?? [],
		forgetGlossaryDecision: ids => pipeline.forgetGlossaryDecision(ids),
	})]);
};


subscribeRequests((request) => {
	if (request.role !== "chat" && request.role !== "compaction") return;
	let notice = document.getElementById("oracle-request-state");
	if (!notice) { notice = document.createElement("div"); notice.id = "oracle-request-state"; notice.setAttribute("role", "status"); notice.className = "text-sm p-2"; document.body.appendChild(notice); }
	const labels: Record<string, string> = { waiting: "Waiting for the local model…", queued: "Waiting for the local model…", executing: "Researching…", running: "Researching…", failed: "Request failed. Any partial answer is incomplete; retry when ready.", interrupted: "Request interrupted. Any partial answer is incomplete.", incomplete: "Answer reached its limit and is incomplete.", busy: "The local model is busy or unavailable. Please retry shortly.", complete: "" };
	notice.textContent = (labels[request.state] ?? request.state) + (request.position ? ` Queue position: ${request.position}.` : "");
	if (["waiting", "queued", "executing", "running"].includes(request.state)) { const cancel = document.createElement("button"); cancel.textContent = "Cancel"; cancel.className = "ml-3 underline"; cancel.onclick = () => agent?.abort(); notice.appendChild(cancel); }
});

let currentSessionId: string | undefined;
let currentTitle = "";
let isEditingTitle = false;
let currentView: "chat" | "about" = "chat";
let quickStartTour: QuickStartTour | undefined;
let agent: Agent;
let memoryEpoch = 0;
let memoryReplacing = false;
let agentCreation = 0;
let sessionSelection = 0;
let sessionLoadPending = false;
const sessionLoadDisabled = new WeakMap<object, boolean>();
const sessionSaves = new Map<string, Promise<void>>();
let graphLoaded = false;
let pendingVoiceEvidence: VoiceEvidence | undefined;
let inFlightVoiceEvidence: VoiceEvidence | undefined;
const sessionAgents = new Map<string, { agent: Agent; title: string }>();
let chatPanel: ChatPanel;
let headerHost: HTMLDivElement;
let aboutHost: HTMLDivElement;
let agentUnsubscribe: (() => void) | undefined;

// Stall-timing scratch (see the agent listener) — last message_update timestamp
// and per-message update count, used to measure the gap from the last streamed
// token to the terminal event.
let lastUpdateAt = 0;
let updateCount = 0;

// --- Browser-local term memory (no server; retrieval runs in-page) ---
let evidenceLedger = new EvidenceLedger();
let recall: RecallSession | undefined;
// The user's term memory — mutable, in-page. Written by the pipeline agents
// after every turn, retrieved by the keyword router before every send.
let userGraph = Graph.empty();
// The per-turn memory pipeline (constructed in initApp once the backend exists).
let pipeline: PipelineRuntime;
let bodyHost: HTMLDivElement; // flex-row wrapper: [leftGutter, chatPanel, rightGutter]
let leftGutter: HTMLDivElement; // term matches
let rightGutter: HTMLDivElement; // pipeline activity feed
let lastVacuum: { terms: TermMatch[] } | null = null;

// --- Voice path (batch STT → agent → streaming TTS) ------------------------
// The voice path now runs THROUGH the same agent as typed chat: batch STT turns
// mic audio into a transcript, agent.prompt() drives the LLM (inheriting the
// Design-2 KG retrieval/injection + ingestion for free), and the assistant's
// streamed text is tapped off the lifecycle listener and spoken via TTS. The
// synth is created lazily on the first voice turn and reused; the STT client is
// reused across turns (reconnected if the socket dropped).
let synth: KyutaiTtsSynthesizer | null = null;
let sttClient: WhisperClient | null = null;
// Voice-turn identity + in-flight tracking (barge-in coherence). Turn-scoped speak
// state (voiceTurnSpeaking / voiceQueue / voiceTurnCut) lives in module globals with no
// run id, so an overlapping turn used to clobber it: a barge-in starts turn 2 while
// run 1 is still generating, and run 1's agent_end then cleared turn 2's flags → turn 2
// went silent and the pipeline fired with the wrong wasVoiceTurn. Fix: each voice send
// bumps voiceTurnSeq; the run's stamped id (inFlightVoiceTurn) is checked at agent_end so
// a stale run only retires ITS OWN turn. And runInFlight gates onStop from launching a
// second agent.prompt on top of a live run — two runs can't share these globals coherently.
let voiceTurnSeq = 0;
let inFlightVoiceTurn: number | null = null; // voice-turn id of the run currently generating (null = typed)
let runInFlight = false; // a main-agent run (voice or typed) is generating
// TTS gate: set true right before a VOICE agent.prompt and held for the WHOLE
// voice turn — across any tool-call round-trip — so the FINAL assistant message
// (the answer generated after a tool result) speaks, not just the first
// (tool-call) message. Cleared at agent_end. Typed turns leave it false → silent.
let voiceTurnSpeaking = false;
// Barge-in guard: set when the turn's TTS is cut (mic toggle / stop button /
// Ctrl+Alt+Space) so trailing text deltas don't reopen a speaker for the rest of
// the turn. Reset at turn start (voiceTurnSpeaking = true) and at agent_end.
let voiceTurnCut = false;
// Push/close async-iterable that feeds the synth the assistant's streamed text
// deltas (the synth drains it through its own sentence chunker → TTS).
let voiceQueue: AsyncStringQueue | null = null;
// Voice-broker lease (only used when VOICE_BROKER_ENABLED). Held for the duration of
// a browser's voice engagement — acquired on the first mic-on, kept alive by a
// heartbeat across turns, released on unload. null = no slot held (the default-off
// path leaves this null forever, so the voice clients build with no URL override).
let voiceLease: { leaseId: string; ttsUrl: string } | null = null;
let voiceHeartbeatTimer: ReturnType<typeof setInterval> | null = null;
// Persistent "speak-but-don't-listen" mute (double-click the stop-audio button),
// remembered per browser. When set, the speaker is never opened on message_start.
const TTS_MUTE_KEY = "myriapod:tts-muted";
let ttsMuted = localStorage.getItem(TTS_MUTE_KEY) === "1";

// A minimal push/close async-iterable: text deltas are pushed in as they stream;
// the synth's `speak()` pulls them (awaiting when the buffer is empty) until
// close(). Buffers deltas that arrive before `speak` starts consuming (it waits
// for the TTS WS `Ready` first), so nothing is lost.
class AsyncStringQueue implements AsyncIterable<string> {
	private queued: string[] = [];
	private resolvers: Array<(r: IteratorResult<string>) => void> = [];
	private closed = false;

	push(s: string): void {
		if (this.closed) return;
		const resolve = this.resolvers.shift();
		if (resolve) resolve({ value: s, done: false });
		else this.queued.push(s);
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		for (const resolve of this.resolvers) resolve({ value: undefined as never, done: true });
		this.resolvers = [];
	}

	[Symbol.asyncIterator](): AsyncIterator<string> {
		return {
			next: (): Promise<IteratorResult<string>> => {
				if (this.queued.length) return Promise.resolve({ value: this.queued.shift()!, done: false });
				if (this.closed) return Promise.resolve({ value: undefined as never, done: true });
				return new Promise((resolve) => this.resolvers.push(resolve));
			},
		};
	}
}

// Load (or lazily register) the named AudioWorklet node — mirrors stt.ts's
// helper: construct first (module already added), else addModule then construct.
async function getAudioWorkletNode(audioContext: AudioContext, name: string): Promise<AudioWorkletNode> {
	try {
		return new AudioWorkletNode(audioContext, name);
	} catch {
		await audioContext.audioWorklet.addModule(appPath(`${name}.js`));
		return new AudioWorkletNode(audioContext, name);
	}
}

// The agent's system prompt — owned here, not in any transport. It cultivates a
// vivid, ranging conversational register POSITIVELY (curiosity, taste, getting
// genuinely into things) rather than by pinning a fabricated human persona on the
// agent — and it spends no words on what the agent isn't (negative instructions
// waste tokens and make a model dwell on the very thing). Two deliberate design
// choices for a future editor: (1) it counterweights the model's pull toward
// terseness by inviting engagement — never re-add language that licenses being
// concise. (2) it gives NO decline/refusal guidance — total topical freedom is the
// intent, the model's own alignment is the only limiter; don't add a "decline
// gracefully" line, it just teaches refusal. It stays evergreen (no model, version,
// or hardware). It names no specific tools — the agent's tools (memory search/dump,
// web search) are self-describing via their own schemas, which the framework injects.
// Self-hosters should swap in a prompt that fits their own agent. See the README. NOTE:
// this is the SHARED system prompt for both
// voice and typed chat (single agent), so its "talk out loud, no markdown" guidance
// also reaches the typed path.
// Runtime model identity comes from the selected serving profile.

function oraclePrompt(): string {
	return buildOraclePrompt({ modelName: servingPath.model.name, documentation: import.meta.env.VITE_HOSTED_DEMO === "true" ? readmeDoc : undefined });
}

// PROVEN ROOT-CAUSE FIX. pi-web-ui's <message-list> only re-renders when its
// `.messages` prop changes by IDENTITY, but pi-agent-core mutates
// `state.messages` in place (push). So committed messages never repaint — the
// render-call logs showed AgentInterface.renderMessages() running with the new
// count while MessageList.render() never fired (mlRows frozen, sameArrayRef=true).
// Reassigning to a fresh array reference makes the prop identity change, forcing
// MessageList to re-render. requestUpdate() then re-runs renderMessages with the
// new reference. (Also fixes the stuck stop button: a post-finishRun repaint
// re-renders the editor with isStreaming=false.)
// SafeMarkdown sanitizes before DOM insertion. This pass resolves corpus handles
// against the evidence ledger and validates navigation from other chat components.
const SAFE_HREF_SCHEME = /^(https?:|mailto:)/i;
const sanitizeChatAnchors = () => {
	if (!chatPanel) return;
	for (const a of chatPanel.querySelectorAll<HTMLAnchorElement>("a[href]")) {
		const href = (a.getAttribute("href") ?? "").trim();
		const citation = resolveCorpusCitation(href, evidenceLedger, window.location.origin);
		if (citation.kind !== "not-corpus") {
			if (citation.kind === "known") { a.href = new URL(citation.source.source_url, window.location.origin).href; a.target = "_blank"; a.rel = "noopener noreferrer"; }
			else { a.removeAttribute("href"); a.setAttribute("aria-invalid", "true"); a.title = "Unverified citation: this handle was not returned by the library."; a.textContent = `${a.textContent} [unverified source]`; }
			continue;
		}
		if (href && !SAFE_HREF_SCHEME.test(href)) {
			a.removeAttribute("href");
			a.removeAttribute("target");
		}
	}
};

// AgentInterface reacts to the agent's own lifecycle events, so streaming and
// message completion repaint the committed list without our help. This is only
// for EXTERNAL edits to agent.state.messages that emit no event — a voice
// placeholder bubble, a compaction rewrite: poke the view to re-clone, then scrub
// model-emitted anchor hrefs once Lit commits the DOM (see sanitizeChatAnchors).
const repaintChatAfterExternalEdit = () => {
	chatPanel?.agentInterface?.refreshMessages();
	requestAnimationFrame(sanitizeChatAnchors);
};

// The chat panel is mounted once and lives OUTSIDE the reactive render root, so
// no host render ever touches it (re-committing it mid-turn is what wiped the
// streaming message). We only toggle which body element is visible.
const updateBodyVisibility = () => {
	if (!bodyHost || !aboutHost) return;
	const showAbout = currentView === "about";
	bodyHost.style.display = showAbout ? "none" : "";
	aboutHost.style.display = showAbout ? "" : "none";
};

const generateTitle = (messages: AgentMessage[]): string => {
	const firstUserMsg = messages.find((m) => m.role === "user");
	if (!firstUserMsg) return "";

	let text = "";
	const content = firstUserMsg.content;

	if (typeof content === "string") {
		text = content;
	} else {
		const textBlocks = content.filter((c): c is TextContent => c.type === "text");
		text = textBlocks.map((c) => c.text || "").join(" ");
	}

	text = text.trim();
	if (!text) return "";

	const sentenceEnd = text.search(/[.!?]/);
	if (sentenceEnd > 0 && sentenceEnd <= 50) {
		return text.substring(0, sentenceEnd + 1);
	}
	return text.length <= 50 ? text : `${text.substring(0, 47)}...`;
};

const shouldSaveSession = (messages: AgentMessage[]): boolean => {
	const hasUserMsg = messages.some((m) => m.role === "user");
	const hasAssistantMsg = messages.some((m) => m.role === "assistant");
	return hasUserMsg && hasAssistantMsg;
};

const histories = new WeakMap<Agent, ConversationHistory>();
const sessionRevisions = new WeakMap<Agent, number>();

const saveSession = async (owner = agent, sessionId = currentSessionId, title = currentTitle) => {
	if (!storage.sessions || !sessionId || !owner) return;

	const state = { ...owner.state, messages: structuredClone(owner.state.messages) };
	const rawHistory = histories.get(owner)?.snapshot();
	if (owner === agent) state.messages = [...state.messages.filter(m => m.role !== "corpus-ledger"), evidenceLedger.message()];
	if (!rawHistory?.records.length) return;
	const pending = (sessionSaves.get(sessionId) ?? Promise.resolve()).catch(() => {}).then(async () => {
	try {
		const savedTitle = sessionAgents.get(sessionId)?.title || title || generateTitle(state.messages);
		// Preserve the original createdAt across re-saves — saveSession runs on every
		// terminal event, so stamping a fresh createdAt each time would keep resetting the
		// session's birth time (breaking chat-list ordering). First save → mint it.
		const existingMeta = await storage.sessions.getMetadata(sessionId);
		const createdAt = existingMeta?.createdAt ?? new Date().toISOString();

		// Create session data
		const sessionData = {
			id: sessionId,
			title: savedTitle,
			model: state.model!,
			thinkingLevel: state.thinkingLevel,
			messages: state.messages,
			rawHistory,
			createdAt,
			lastModified: new Date().toISOString(),
		};

		// Create session metadata
		const metadata = {
			id: sessionId,
			title: savedTitle,
			createdAt: sessionData.createdAt,
			lastModified: sessionData.lastModified,
			messageCount: rawHistory?.records.length ?? state.messages.length,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					total: 0,
				},
			},
			modelId: state.model?.id || null,
			thinkingLevel: state.thinkingLevel,
			preview: generateTitle(state.messages),
		};

		const revision = sessionRevisions.get(owner) ?? -1;
		await storage.sessions.save(sessionData, metadata, revision);
		sessionRevisions.set(owner, revision < 0 ? 1 : revision + 1);
		dbg(`saveSession OK — id=${sessionId}, ${summarizeMessages(state.messages)}`);
	} catch (err) {
		dbgWarn(`saveSession FAILED — id=${sessionId}:`, err);
		if (owner === agent) { const notice = document.getElementById("oracle-request-state"); if (notice) notice.textContent = `Conversation not saved: ${err instanceof Error ? err.message : String(err)}`; }
		throw err;
	}
	});
	sessionSaves.set(sessionId, pending);
	await pending;
	if (sessionSaves.get(sessionId) === pending) sessionSaves.delete(sessionId);
};

async function renameSessionTitle(newTitle: string): Promise<void> {
	const sessionId = currentSessionId;
	if (!sessionId || !newTitle || newTitle === currentTitle) { isEditingTitle = false; renderHeader(); return; }
	const pending = (sessionSaves.get(sessionId) ?? Promise.resolve()).then(async () => {
		const owner = sessionAgents.get(sessionId);
		const revision = await storage.sessions.updateTitle(sessionId, newTitle, owner ? sessionRevisions.get(owner.agent) ?? -1 : undefined);
		if (owner) { owner.title = newTitle; sessionRevisions.set(owner.agent, revision); }
		if (currentSessionId === sessionId) currentTitle = newTitle;
	});
	const settled = pending.catch(() => undefined);
	sessionSaves.set(sessionId, settled);
	try { await pending; }
	catch (error) { dbgError("Chat title could not be saved:", error); alert("Chat title could not be saved. Please retry."); }
	if (sessionSaves.get(sessionId) === settled) sessionSaves.delete(sessionId);
	if (currentSessionId === sessionId) { isEditingTitle = false; renderHeader(); }
}

const updateUrl = (sessionId: string) => {
	const url = new URL(window.location.href);
	url.searchParams.set("session", sessionId);
	window.history.replaceState({}, "", url);
};


// --- Memory consent --------------------------------------------------------
// Personal-memory access and background processing require explicit consent.
// "undecided" = the consent modal hasn't been answered yet in this browser.
let memoryConsent: ConsentChoice | "undecided" = "undecided";
// Assigned in initApp once the memory button exists, so the pipeline can repaint it.
let refreshMemoryUi: () => void = () => {};
let consentChange = 0;
let consentInFlight: Promise<void> | undefined;

async function loadMemoryConsent(): Promise<void> {
	try {
		memorySnapshot = await memoryStorage.load();
		if (memorySnapshot.consent.present) {
			const v = memorySnapshot.consent.value;
			if (v !== "granted" && v !== "declined") throw new Error("Invalid saved memory consent");
			memoryConsent = v;
		}
	} catch (err) {
		memoryConsent = "declined";
		memorySnapshot = undefined;
		reportMemoryFailure(err);
	}
}

async function setMemoryConsent(choice: ConsentChoice): Promise<void> {
	const change = ++consentChange;
	if (choice === "granted" && pipeline && (!graphLoaded || !pipeline.isLoaded)) throw new Error("Saved memory could not be loaded. Reload before enabling memory.");
	if (choice !== "granted") {
		memoryConsent = choice;
		await pipeline?.cancel();
		invalidateMemoryContext();
		refreshAgentMemory();
		refreshMemoryUi();
	}
	await writeMemory({ consent: choice });
	if (change !== consentChange) return;
	memoryConsent = choice;
	if (choice === "granted" && servingPath) void pipeline?.resumePending();
	refreshAgentMemory();
	refreshMemoryUi();
}

// Show the consent modal once, on the first interaction (send OR mic toggle), if
// the visitor hasn't decided. Fire-and-forget: the conversation proceeds; the
// answer just gates whether this turn and later ones get ingested.
async function ensureMemoryConsent(): Promise<void> {
	if (memoryConsent !== "undecided") return;
	if (!consentInFlight) consentInFlight = (async () => {
		await setMemoryConsent(await showConsentModal());
	})().finally(() => { consentInFlight = undefined; });
	await consentInFlight;
}

// Fold a background pipeline call's tokens + cost into the SESSION total. The
// framework's stats line sums msg.usage over assistant messages, so attributing
// pipeline spend to the latest assistant message makes the displayed total the true
// session cost (chat + every background call the chat triggered) — no override of
// framework UI. (Local model costs are zero; token usage remains visible.)
function addIngestionCostToSession(promptTokens: number, completionTokens: number, sessionKey: string): void {
	const owner = sessionAgents.get(sessionKey);
	if (!owner) return;
	const c = MYRIAPOD_MODEL.cost;
	const inCost = (promptTokens / 1_000_000) * c.input;
	const outCost = (completionTokens / 1_000_000) * c.output;
	type Usage = {
		input: number;
		output: number;
		cost?: { input?: number; output?: number; total?: number };
	};
	const msgs = owner.agent.state.messages as unknown as Array<{ role: string; usage?: Usage }>;
	for (let i = msgs.length - 1; i >= 0; i--) {
		const m = msgs[i];
		if (m.role === "assistant" && m.usage) {
			m.usage.input += promptTokens;
			m.usage.output += completionTokens;
			if (m.usage.cost) {
				m.usage.cost.input = (m.usage.cost.input ?? 0) + inCost;
				m.usage.cost.output = (m.usage.cost.output ?? 0) + outCost;
				m.usage.cost.total = (m.usage.cost.total ?? 0) + inCost + outCost;
			}
			break;
		}
	}
	void saveSession(owner.agent, sessionKey, owner.agent === agent ? currentTitle : owner.title).catch(error => dbgError("Conversation persistence failed", error));
	if (owner.agent === agent) chatPanel.agentInterface?.requestUpdate?.();
	dbg(`pipeline cost folded into session: +${promptTokens}in/${completionTokens}out tok, +$${(inCost + outCost).toFixed(6)}`);
}

// -- Lexicon persistence + export/import -------------------------------------

// One term memory per browser. Loaded at boot, saved after each pipeline tick.
async function loadUserGraph(): Promise<void> {
	try {
		if (!memorySnapshot) throw new Error("Saved memory could not be loaded");
		if (memorySnapshot.graph.present) {
			userGraph = new Graph(memorySnapshot.graph.value as GraphAsset);
			dbg(`term memory loaded: ${userGraph.thoughts.size} terms`);
		}
		graphLoaded = true;
	} catch (err) {
		dbgError("term memory load failed; saved data retained:", err);
		throw err;
	}
}

function reportMemoryFailure(error: unknown): void {
	dbgError("Personal memory operation failed:", error);
	if (memoryStorage.invalidated) {
		memoryConsent = "declined";
		void pipeline?.cancel(false).catch(error => dbgError("Memory cancellation failed:", error));
		invalidateMemoryContext();
		refreshAgentMemory();
		refreshMemoryUi();
	}
	let notice = document.getElementById("memory-storage-error");
	if (!notice) {
		notice = document.createElement("div");
		notice.id = "memory-storage-error";
		notice.setAttribute("role", "alert");
		notice.className = "p-3 border border-red-400 text-sm";
		document.body.appendChild(notice);
	}
	notice.textContent = memoryStorage.invalidated
		? "Personal memory changed in another tab. Memory is disabled here. Reload to use the saved state; it has not been overwritten."
		: "Personal memory could not be loaded or saved. Your last saved data is retained. Export any unsaved memory before reloading to retry.";
}

async function writeMemory(update: MemoryUpdate, assertActive?: () => void): Promise<void> {
	try { await memoryStorage.save(update, assertActive); }
	catch (error) { reportMemoryFailure(error); throw error; }
}

function invalidateMemoryContext(): void {
	memoryEpoch++;
	recall?.reset();
	pendingVoiceEvidence = undefined;
	inFlightVoiceEvidence = undefined;
	if (agent) {
		agent.abort();
		agent.state.messages = withoutPersonalMemory(agent.state.messages);
		repaintChatAfterExternalEdit();
	}
	updateGutters({ terms: [] });
}

function refreshAgentMemory(): void {
	if (!agent) return;
	agent.state.systemPrompt = oraclePrompt() +
		(memoryConsent === "granted" ? pipeline?.runningContextBlock() ?? "" : "");
	const epoch = memoryEpoch;
	const memoryGraph = () => {
		if (memoryConsent !== "granted" || memoryReplacing || memoryStorage.invalidated || epoch !== memoryEpoch) throw new Error("Personal memory is off or has changed");
		return userGraph;
	};
	const owner = agent;
	const history = histories.get(owner);
	const generation = agentCreation;
	agent.state.tools = [
		...(history ? [createConversationHistoryTool(history, () => { if (owner !== agent || generation !== agentCreation || epoch !== memoryEpoch) throw new Error("Conversation or memory consent changed"); }, message => memoryConsent === "granted" ? message : historyWithoutPersonalMemory(message))] : []),
		...createCorpusTools(evidenceLedger),
		...(memoryConsent === "granted" && !memoryReplacing ? [createMemorySearchTool(memoryGraph), createMemoryDumpTool(memoryGraph)] : []),
		createWebSearchTool({ endpoint: WEB_SEARCH_ENDPOINT,
			getBearer: () => "" }),
	];
}

// Export: download the lexicon as JSON (the real durability story — IndexedDB
// can be evicted and PersistentStorageDialog is broken upstream).
function downloadLexicon(): void {
	void exportLexicon().catch(reportMemoryFailure);
}

async function exportLexicon(): Promise<void> {
	const saved = await memoryStorage.exportData();
	const asset = makeLexiconAsset(saved);
	const blob = new Blob([JSON.stringify(asset, null, 2)], {
		type: "application/json",
	});
	const url = URL.createObjectURL(blob);
	const a = document.createElement("a");
	a.href = url;
	a.download = `almanac-lexicon-${new Date().toISOString().slice(0, 10)}.json`;
	a.click();
	URL.revokeObjectURL(url);
}

// Import: replace the lexicon from an uploaded export and persist it.
async function importLexiconFromFile(file: File): Promise<void> {
	let asset: unknown;
	try {
		asset = JSON.parse(await file.text());
	} catch {
		// A non-JSON / truncated file throws a raw SyntaxError before the shape check —
		// surface the same friendly error instead.
		throw new Error("not a valid lexicon export");
	}
	await replaceLexicon(await parseLexiconAsset(asset));
	dbg(`lexicon imported: ${userGraph.thoughts.size} terms`);
}

async function replaceLexicon(replacement: LexiconReplacement): Promise<void> {
	if (memoryReplacing) throw new Error("Another memory replacement is in progress");
	memoryReplacing = true;
	const settling = pipeline.cancel();
	invalidateMemoryContext();
	refreshAgentMemory();
	try {
	await settling;
	const snapshot = replacementPipeline(replacement, pipeline.snapshot().generation ?? 0);
	await writeMemory({ graph: replacement.graph.serialize(), pipeline: snapshot, clearArchive: true, archive: replacement.archive });
	userGraph = replacement.graph;
	graphLoaded = true;
	pipeline.restore(snapshot);
	pipeline.activity.length = 0;
	} finally {
		memoryReplacing = false;
		refreshAgentMemory();
		renderGutters();
	}
}

async function deleteLexicon(): Promise<void> {
	await replaceLexicon({graph: Graph.empty(), sttLexicon: emptySttLexicon(), runningContext: [], archive: [], maintenance: emptyMaintenance()});
}

// agent.prompt accepts a string or an AgentMessage[]; pull the user's text out.
const extractUserText = (input: AgentMessage | AgentMessage[] | string): string => {
	if (typeof input === "string") return input;
	const msgs = Array.isArray(input) ? input : [input];
	const parts: string[] = [];
	for (const m of msgs) {
		const c = (m as { content?: unknown }).content;
		if (typeof c === "string") parts.push(c);
		else if (Array.isArray(c))
			for (const blk of c) {
				if (blk && typeof blk === "object" && (blk as TextContent).type === "text") {
					parts.push((blk as TextContent).text ?? "");
				}
			}
	}
	return parts.join(" ");
};

// The gutters: term matches (left) + the pipeline activity feed (right). Owned
// plain DOM we update imperatively. The left column renders admitted recall.
// The right column renders the
// pipeline agents' recorded actions — the memory tending itself, made visible.
const termCard = (t: TermMatch) => html`<div class="cw-term">
	<div class="cw-term-label">${t.label}</div>
	<div class="cw-term-desc">${t.description}</div>
</div>`;
const activityCard = (agent: string, line: string) => html`<div class="cw-activity">
	<span class="cw-activity-agent">${agent}</span>
	<span class="cw-activity-line">${line}</span>
</div>`;

const renderGutters = () => {
	if (!leftGutter || !rightGutter) return;
	const terms = lastVacuum?.terms ?? [];
	// Newest activity on top.
	const activity = pipeline ? [...pipeline.activity].reverse() : [];

	render(
		html`
			<div class="cw-gutter-title">Memory</div>
			<div class="cw-gutter-inner">
				${terms.length ? terms.map(termCard) : html`<div class="cw-gutter-empty">no matches</div>`}
			</div>
		`,
		leftGutter,
	);
	render(
		html`
			<div class="cw-gutter-title">Activity</div>
			<div class="cw-gutter-inner">
				${
					activity.length
						? activity.map((a) => activityCard(a.agent, a.line))
						: html`<div class="cw-gutter-empty">no activity yet</div>`
				}
			</div>
		`,
		rightGutter,
	);
};

// Dynamic truncation: keep EVERY term visible, but progressively clamp the
// descriptions (uniformly) until the column fits without scrolling. Few terms →
// full descriptions; many terms → each shrinks toward its first line. Measured
// against the live gutter height so it adapts to viewport + term count.
const fitTermDescriptions = () => {
	if (!leftGutter || leftGutter.clientHeight === 0) return;
	const inner = leftGutter.querySelector<HTMLElement>(".cw-gutter-inner");
	const descs = [...leftGutter.querySelectorAll<HTMLElement>(".cw-term-desc")];
	if (!inner || !descs.length) return;
	const apply = (n: number) => {
		for (const d of descs) d.style.webkitLineClamp = String(n);
	};
	let clamp = 8; // generous start: a full ~60-word desc is ~8 lines at this width
	apply(clamp);
	// Reading scrollHeight forces a reflow; bounded to ≤7 iterations, once/turn.
	while (clamp > 1 && inner.scrollHeight > leftGutter.clientHeight) {
		clamp -= 1;
		apply(clamp);
	}
};

const updateGutters = (vacuum: { terms: TermMatch[] }) => {
	lastVacuum = vacuum;
	renderGutters();
	// Fit term descriptions to the column height after layout settles.
	requestAnimationFrame(fitTermDescriptions);
};

// Re-fit on viewport resize (descriptions stay in the DOM; just re-clamp).
let resizeTimer: ReturnType<typeof setTimeout> | undefined;
window.addEventListener("resize", () => {
	clearTimeout(resizeTimer);
	resizeTimer = setTimeout(fitTermDescriptions, 150);
});

const createAgent = async (initialState?: Partial<AgentState>, savedHistory?: ConversationArchive, savedRevision = -1) => {
	if (chatPanel.agentInterface) chatPanel.agentInterface.sendDisabled = true;
	const creation = ++agentCreation;
	recall?.reset();
	if (agent) agent.abort();
	synth?.stop();
	voiceQueue?.close();
	voiceQueue = null;
	voiceTurnSpeaking = false;
	inFlightVoiceEvidence = undefined;
	runInFlight = false;
	const sessionKey = currentSessionId ?? crypto.randomUUID();
	currentSessionId = sessionKey;
	pipeline?.startSession(sessionKey);
	if (agentUnsubscribe) {
		agentUnsubscribe();
	}

	const resolvedPath = await resolveServingPath();
	if (creation !== agentCreation) return;
	servingPath = resolvedPath;
	const baseState: Partial<AgentState> = initialState ?? {
		thinkingLevel: MYRIAPOD_THINKING_LEVEL,
		messages: [],
		tools: [],
	};
	let sessionRecall: RecallSession;
	agent = new Agent({
		initialState: {
			...baseState,
			messages: memoryConsent === "granted" ? (baseState.messages ?? []).filter((m) => m.role !== "memory-context") : withoutPersonalMemory(baseState.messages ?? []),
			model: servingPath.model,
			systemPrompt: oraclePrompt() + (memoryConsent === "granted" ? pipeline?.runningContextBlock() ?? "" : ""),
		},
		// Custom transformer: convert custom messages to LLM-compatible format
		convertToLlm: customConvertToLlm,
		streamFn: async (model, context, options) => {
			const epoch = memoryEpoch;
			let prepared: Awaited<ReturnType<RecallSession["prepare"]>>;
			for (;;) {
				try { prepared = await sessionRecall.prepare(context, async candidate => countRequestTokens(await serializeModelRequest(candidate), "chat", options?.signal), releaseProfile().roles.chat.maxInputTokens); break; }
				catch (error) { if (!(error instanceof StaleRecallError) || creation !== agentCreation || epoch !== memoryEpoch || options?.signal?.aborted) throw error; }
			}
			if (creation !== agentCreation || epoch !== memoryEpoch || options?.signal?.aborted) throw new Error("Conversation or personal memory changed before request admission");
			return createLocalStreamFn("chat", () => sessionKey, undefined, requestId => {
				if (creation === agentCreation && epoch === memoryEpoch) prepared.admitted(requestId);
			})(model, prepared.context, options);
		},
		getApiKey: () => "local",
	});

	evidenceLedger = new EvidenceLedger();
	evidenceLedger.restore(agent.state.messages);
	const owner = agent;
	const history = new ConversationHistory(savedHistory, initialState?.messages);
	evidenceLedger.restore(history.messages());
	histories.set(owner, history);
	sessionRevisions.set(owner, savedRevision);
	let preparation: AbortController | undefined;
	const abort = owner.abort.bind(owner);
	owner.abort = () => { preparation?.abort(); abort(); };
	sessionAgents.set(sessionKey, { agent: owner, title: currentTitle });
	const isCurrent = () => owner === agent && creation === agentCreation;
	sessionRecall = new RecallSession({
		policy: PROVISIONAL_RECALL_POLICY,
		active: () => isCurrent() && memoryConsent === "granted" && !memoryReplacing && !memoryStorage.invalidated,
		graph: () => userGraph,
		updateCounters: operation => pipeline.updateRetrievalCounters(operation),
		onDelivery: receipt => {
			history.capture({ role: "memory-delivery", receipt, timestamp: Date.now() });
			updateGutters({ terms: receipt.terms.map(term => ({ label: term.label, description: term.description, hit_count: userGraph.thoughts.get(term.id)?.hit_count ?? 0, matched_surface: term.matches[0]?.surface ?? term.label, matched_via: term.matches[0]?.via ?? "label" })) });
		},
	});
	recall = sessionRecall;
	const sources = evidenceLedger;
	owner.prepareNextTurnWithContext = async ({ context, toolResults }, signal) => {
		if (!toolResults.length || !isCurrent()) return;
		const epoch = memoryEpoch;
		try {
			for (const result of toolResults) await sessionRecall.observe("tool", result.content.filter(block => block.type === "text").map(block => block.type === "text" ? block.text : "").join("\n"));
			const p = releaseProfile();
			const summarize = makeCompletion({ baseUrl: servingPath.baseUrl, model: p.model.id, role: "compaction", conversationId: sessionKey });
			await saveSession(owner, sessionKey);
			const messages = await compactContext({
				convert: customConvertToLlm, messages: context.messages, ledger: sources.message(), inputBudget: p.roles.chat.maxInputTokens, summaryInputBudget: p.roles.compaction.maxInputTokens,
				measure: async messages => countRequestTokens(await serializeModelRequest({ systemPrompt: context.systemPrompt, messages: customConvertToLlm(messages), tools: context.tools }), "chat", signal),
				measureSummary: text => countRequestTokens({ model: p.model.id, messages: [{ role: "system", content: COMPACTION_INSTRUCTIONS }, { role: "user", content: text }] }, "compaction", signal),
				summarize: text => summarize([{ role: "system", content: COMPACTION_INSTRUCTIONS }, { role: "user", content: text }], signal),
				isCurrent: () => isCurrent() && epoch === memoryEpoch && !signal?.aborted,
			});
			if (!isCurrent() || epoch !== memoryEpoch || signal?.aborted) return;
			if (messages !== context.messages) { owner.state.messages = messages; repaintChatAfterExternalEdit(); return { context: { ...context, messages } }; }
		} catch (error) {
			dbgError("Research context could not be prepared", error);
			owner.abort();
			if (isCurrent()) { const notice = document.getElementById("oracle-request-state"); if (notice) notice.textContent = `Research interrupted: ${error instanceof Error ? error.message : String(error)}`; }
		}
	};
	if (memoryConsent !== "granted") invalidateMemoryContext();

	// Observe accepted input after context preparation; recall is injected per request.
	const origPrompt = agent.prompt.bind(agent);
	(agent as unknown as { prompt: (...a: unknown[]) => Promise<void> }).prompt = async (
		input: unknown,
		...rest: unknown[]
	) => {
		const selection = sessionSelection;
		const canSend = () => isCurrent() && selection === sessionSelection && !sessionLoadPending;
		if (!canSend()) throw new Error("Conversation has changed or is loading");
		if (runInFlight) {
			dbgWarn("prompt() re-entered while a run is already in flight — dropping the racing send");
			throw new Error("a run is already in flight");
		}
		// Bracket the run: a run is now in flight (gates onStop's barge-in send), and stamp
		// it with this turn's voice id if it's a voice turn (onStop set voiceTurnSpeaking +
		// bumped voiceTurnSeq before calling us) so agent_end retires the right turn. Cleared
		// at agent_end.
		runInFlight = true;
		try { releaseProfile(); await ensureMemoryConsent(); }
		catch (error) { if (isCurrent()) runInFlight = false; throw error; }
		if (!canSend()) { if (isCurrent()) runInFlight = false; throw new Error("Conversation changed before send"); }
		preparation = new AbortController();
		const preparationSignal = preparation.signal;
		inFlightVoiceTurn = voiceTurnSpeaking ? voiceTurnSeq : null;
		inFlightVoiceEvidence = voiceTurnSpeaking ? pendingVoiceEvidence : undefined;
		pendingVoiceEvidence = undefined;
		const promptEpoch = memoryEpoch;
		if (!canSend() || promptEpoch !== memoryEpoch) { if (isCurrent()) runInFlight = false; throw new Error("Conversation or memory changed before send"); }
		try {
			const before = agent.state.messages;
			const incoming: AgentMessage[] = typeof input === "string" ? [{ role: "user", content: input, timestamp: Date.now() }] : Array.isArray(input) ? input : [input as AgentMessage];
			const p = releaseProfile();
			const summaryCompletion = makeCompletion({ baseUrl: servingPath.baseUrl, model: p.model.id, role: "compaction", conversationId: sessionKey });
			await saveSession(owner, sessionKey);
			const prepared = await compactContext({
				convert: customConvertToLlm, messages: before, ledger: evidenceLedger.message(), inputBudget: p.roles.chat.maxInputTokens, summaryInputBudget: p.roles.compaction.maxInputTokens,
				preserveLatestUser: false,
				measure: async messages => countRequestTokens(await serializeModelRequest({ systemPrompt: owner.state.systemPrompt, messages: customConvertToLlm([...messages, ...incoming]), tools: owner.state.tools }), "chat", preparationSignal),
				measureSummary: text => countRequestTokens({ model: p.model.id, messages: [{ role: "system", content: COMPACTION_INSTRUCTIONS }, { role: "user", content: text }] }, "compaction", preparationSignal),
				summarize: text => summaryCompletion([{ role: "system", content: COMPACTION_INSTRUCTIONS }, { role: "user", content: text }], preparationSignal),
				isCurrent: () => canSend() && promptEpoch === memoryEpoch && !preparationSignal.aborted,
			});
			if (!canSend() || promptEpoch !== memoryEpoch || preparationSignal.aborted) throw new Error("Conversation changed or was cancelled during context preparation");
			if (prepared !== before) { owner.state.messages = prepared; repaintChatAfterExternalEdit(); }
			await sessionRecall.observe("message", extractUserText(incoming));
			if (!canSend() || promptEpoch !== memoryEpoch || preparationSignal.aborted) throw new Error("Conversation changed or was cancelled during recall preparation");
		} catch (error) { if (isCurrent()) runInFlight = false; throw error; }
		try { return await origPrompt(input as AgentMessage | AgentMessage[], ...(rest as [])); }
		finally { preparation = undefined; if (isCurrent()) runInFlight = false; }
	};

	agentUnsubscribe = agent.subscribe((event: any) => {
		if (!isCurrent()) return;
		// pi-agent-core emits raw lifecycle events (message_start,
		// message_update, message_end, turn_end, agent_end, tool_execution_*) —
		// NOT a synthetic "state-update" with an attached `event.state`. The
		// shipped example listened for "state-update", so its bookkeeping never
		// ran and nothing was persisted. We read state straight off the agent.
		//
		// CRITICAL: the core AWAITS each listener, so a throw here (or heavy work
		// on every streamed token) stalls the run and can wipe the in-flight
		// message. So: wrap everything in try/catch, and only re-render / persist
		// on meaningful events — NOT on every message_update token. ChatPanel
		// renders the streaming message itself; our renderApp is just for the
		// header shell.
		try {
			const type = event?.type;
			if (type === "message_end" && event.message) history.capture(event.message);
			const isTerminal = type === "message_end" || type === "agent_end";
			const messages = agent.state.messages;

			// STALL TIMING — correlate the agent lifecycle against the wire tap.
			// We DON'T log every message_update (per-token fetch would itself stall
			// the run), but we track the last-update timestamp + count locally and
			// report the gap on terminal events. A large "last update → end" gap
			// here, combined with the [stream] wire log, localizes the ~13s stall:
			// if the wire shows the same gap it's the provider; if the wire closed
			// fast but this gap is large it's pi-ai/agent-core post-processing.
			const tNow = Math.round(performance.now());
			if (type === "message_start") {
				lastUpdateAt = tNow;
				updateCount = 0;
			} else if (type === "message_update") {
				lastUpdateAt = tNow;
				updateCount++;
			}

			// VOICE TTS TAP. ONE speaker per TURN, not per message. A voice turn
			// (voiceTurnSpeaking, held across the whole turn incl. tool-call round-trips)
			// opens a single TTS queue on the FIRST text delta of the turn and feeds
			// EVERY assistant message's text into it. A tool call mid-turn is just a pause
			// in the text stream: the queue blocks, the current audio keeps draining via
			// the synth's pace timer, and the post-tool answer resumes the SAME speaker.
			// This is the fix for the tool-call cut — a per-message speaker would call
			// synth.speak() again, and run() bumps the synth epoch + resets pacing on
			// entry, wiping the still-playing pre-tool audio. At each message boundary we
			// push a newline so the chunker flushes a mid-clause tail (a tool-call message
			// that ended without terminal punctuation) instead of concatenating it with
			// the next message's first words. toolResult messages emit no text_delta.
			// Typed turns leave voiceTurnSpeaking false → silent. Keep this CHEAP — the
			// core awaits each listener, so push-to-queue only.
			if (type === "message_update" && event.assistantMessageEvent?.type === "text_delta") {
				if (voiceTurnSpeaking && !ttsMuted && synth && !voiceQueue && !voiceTurnCut) {
					voiceQueue = new AsyncStringQueue();
					synth.speak(voiceQueue).catch((err) => dbgError("voice TTS speak failed (non-fatal):", err));
				}
				voiceQueue?.push(event.assistantMessageEvent.delta);
			} else if (type === "message_end") {
				// Flush the chunker at the boundary; keep the speaker OPEN for the turn.
				voiceQueue?.push("\n");
			}

			// Light logging — skip the per-token message_update spam.
			if (type !== "message_update") {
				const gapNote =
					lastUpdateAt > 0 ? ` [t=${tNow}ms, ${updateCount} updates, +${tNow - lastUpdateAt}ms since last update]` : "";
				dbg(`event ${type}: ${summarizeMessages(messages)}${gapNote}`);
			}

			let headerChanged = false;

			// Generate title after the first user+assistant exchange.
			if (!currentTitle && shouldSaveSession(messages)) {
				currentTitle = generateTitle(messages);
				headerChanged = true;
				sessionAgents.get(sessionKey)!.title = currentTitle;
			}

			// Mint the session id as soon as there's something worth saving, so
			// the URL carries ?session= and the conversation survives a reload.
			if (!currentSessionId && shouldSaveSession(messages)) {
				currentSessionId = crypto.randomUUID();
				dbg(`session id minted: ${currentSessionId}`);
				updateUrl(currentSessionId);
			}

			// Persist on terminal events (not once per streamed token).
			if (currentSessionId && isTerminal) {
				if (history.snapshot().records.length) updateUrl(currentSessionId);
				void saveSession().catch(error => dbgError("Conversation persistence failed", error));
			}

			// AgentInterface repaints its own committed list on message completion.
			// We only scrub model-emitted anchor hrefs after Lit commits the freshly
			// rendered links (see sanitizeChatAnchors) — the app's XSS concern, not
			// the component's.
			if (isTerminal) {
				requestAnimationFrame(sanitizeChatAnchors);
			}
			if (type === "agent_end") {
				runInFlight = false; // this run is done — a barge-in send may now proceed
				// The ending run carried a stamped voice-turn id (or null if it was typed).
				// wasVoiceTurn drives the pipeline's STT functions; it must reflect THIS run,
				// not the module global a barge-in may have since flipped.
				const endingVoiceTurn = inFlightVoiceTurn;
				inFlightVoiceTurn = null;
				const wasVoiceTurn = endingVoiceTurn !== null;
				// Retire the shared speak state ONLY if this ending run is still the current
				// voice turn — a stale run (superseded by a later barge-in) must leave the newer
				// turn's voiceTurnSpeaking / voiceQueue / voiceTurnCut untouched.
				if (wasVoiceTurn && endingVoiceTurn === voiceTurnSeq) {
					voiceTurnSpeaking = false; // turn truly done (no more tool calls) → retire the speak intent
					voiceQueue?.close(); // close the turn's single speaker (drains remaining audio, then ends)
					voiceQueue = null;
					voiceTurnCut = false; // reset the barge-in guard for the next turn
				}
				// The turn is over → one pipeline tick (consent-gated; fire-and-forget;
				// every completed exchange retains its own queued tick).
				if (memoryConsent === "granted") {
					const captured = history.snapshot();
					const voiceEvidence = inFlightVoiceEvidence;
					const epoch = memoryEpoch;
					inFlightVoiceEvidence = undefined;
					void (async () => {
						await saveSession(owner, sessionKey);
						if (!isCurrent() || epoch !== memoryEpoch || memoryConsent !== "granted") return;
						const saved = await storage.sessions.get(sessionKey);
						if (!saved?.rawHistory || !isCurrent() || epoch !== memoryEpoch || memoryConsent !== "granted") return;
						await pipeline.onTurnEndHistory({ sessionKey, revision: saved.revision ?? 0, archive: captured }, wasVoiceTurn, voiceEvidence);
					})().catch(reportMemoryFailure);
				}
			}

			// Re-render ONLY the header (its own DOM node) and ONLY when its
			// contents change — e.g. the title appears after the first exchange.
			// The chat panel is mounted once and is NEVER touched by the host.
			if (headerChanged) {
				renderHeader();
			}
		} catch (err) {
			dbgError("agent listener threw (suppressed so the run survives):", err);
		}
	});

	await chatPanel.setAgent(agent, {
		onApiKeyRequired: async (provider: string) => {
			if (provider === MYRIAPOD_PROXY_PROVIDER) return true;
			return false;
		},
		toolsFactory: () => [],
	});

	if (creation !== agentCreation) return;
	if (chatPanel.agentInterface) {
		chatPanel.agentInterface.getSourceMessages = () => history.messages();
		chatPanel.agentInterface.enableModelSelector = false;
		chatPanel.agentInterface.enableThinkingSelector = false;
	}

	refreshAgentMemory();
	if (memoryConsent === "granted") void pipeline.resumePending();
};

const loadSession = async (sessionId: string): Promise<boolean> => {
	const selection = ++sessionSelection;
	if (!storage.sessions) return false;
	const previousInterface = chatPanel.agentInterface;
	const previouslyDisabled = previousInterface ? sessionLoadDisabled.get(previousInterface) ?? previousInterface.sendDisabled : false;
	sessionLoadPending = true;
	if (previousInterface) {
		sessionLoadDisabled.set(previousInterface, previouslyDisabled);
		previousInterface.sendDisabled = true;
	}
	try {
		const sessionData = await storage.sessions.get(sessionId);
		if (selection !== sessionSelection) return false;
		if (!sessionData) {
			dbgWarn(`loadSession: session not found in storage: ${sessionId}`);
			return false;
		}
		dbg(`loadSession OK: ${sessionId} — ${summarizeMessages(sessionData.messages ?? [])}`);

		const metadata = await storage.sessions.getMetadata(sessionId);
		if (selection !== sessionSelection) return false;
		currentSessionId = sessionId;
		currentView = "chat";
		currentTitle = metadata?.title || "";

		await createAgent({
			model: MYRIAPOD_MODEL,
			thinkingLevel: MYRIAPOD_THINKING_LEVEL,
			messages: sessionData.messages,
			tools: [],
		}, sessionData.rawHistory, sessionData.revision ?? 0);

		if (selection !== sessionSelection) return false;
		updateUrl(sessionId);
		updateBodyVisibility();
		renderHeader();
		return true;
	} catch (error) {
		if (selection === sessionSelection) {
			dbgError("Saved conversation could not be loaded; retained without modification", error);
			alert(`This conversation could not be loaded. Its saved data has been retained; export it from Chats to repair and re-import it. ${error instanceof Error ? error.message : String(error)}`);
		}
		return false;
	} finally {
		if (selection === sessionSelection) {
			sessionLoadPending = false;
			if (previousInterface && chatPanel.agentInterface === previousInterface) previousInterface.sendDisabled = previouslyDisabled;
			if (previousInterface) sessionLoadDisabled.delete(previousInterface);
		}
	}
};

const newSession = async () => {
	const selection = ++sessionSelection;
	sessionLoadPending = false;
	agentCreation++;
	dbg("newSession() — resetting to a fresh chat (no page reload)");
	currentSessionId = undefined;
	currentTitle = "";
	isEditingTitle = false;
	currentView = "chat";
	// Clear ?session= without reloading the page (buttons shouldn't refresh the
	// page; a reload mid-stream is also how conversations vanished).
	const url = new URL(window.location.href);
	url.search = "";
	window.history.replaceState({}, "", url);
	await createAgent();
	if (selection !== sessionSelection) return;
	updateBodyVisibility();
	renderHeader();
};

const setView = (view: "chat" | "about") => {
	// No-op (and no reset) if already on this view — clicking the brand while on
	// the chat page must NOT wipe the chat.
	if (currentView === view) return;
	currentView = view;
	updateBodyVisibility();
	renderHeader();
};

const renderAbout = () => html`
	<div class="flex-1 overflow-y-auto">
		<div class="cw-about max-w-2xl mx-auto">
			${unsafeHTML(
				(marked.parse(aboutDoc) as string).replace(
					/<a href="(https?:\/\/)/g,
					'<a target="_blank" rel="noreferrer" href="$1',
				),
			)}
		</div>
	</div>
`;

// ============================================================================
// RENDER
// ============================================================================
const renderHeader = () => {
	if (!headerHost) return;
	dbg(`renderHeader view=${currentView}`);

	const headerHtml = html`
			<!-- Header -->
			<div class="cw-header flex items-center justify-between border-b border-border shrink-0">
				<div class="flex items-center gap-1 px-4 py-2">
					<button
						class="text-primary text-base font-semibold px-1 mr-1 hover:opacity-80 transition-opacity"
						@click=${() => setView("chat")}
					>
						Almanac
					</button>
					${aboutDoc.trim() ? Button({
						variant: "ghost",
						size: "sm",
						children: "About",
						onClick: () => setView("about"),
					}) : null}
					${Button({
						variant: "ghost",
						size: "sm",
						children: icon(History, "sm"),
						onClick: () => {
							SessionListDialog.open(
								async (sessionId) => {
									await loadSession(sessionId);
								},
								(deletedSessionId) => {
									void pipeline?.sourceDeleted(deletedSessionId).catch(reportMemoryFailure);
									// Only reload if the current session was deleted
									if (deletedSessionId === currentSessionId) {
										newSession();
									}
								},
							);
						},
						title: "Chats",
					})}
					${Button({
						variant: "ghost",
						size: "sm",
						children: icon(Plus, "sm"),
						onClick: newSession,
						title: "New Chat",
					})}

					${
						currentView === "chat" && currentTitle
							? isEditingTitle
								? html`<div class="flex items-center gap-2">
									${Input({
										type: "text",
										value: currentTitle,
										className: "text-sm w-64",
										onChange: async (e: Event) => {
											const newTitle = (e.target as HTMLInputElement).value.trim();
											await renameSessionTitle(newTitle);
										},
										onKeyDown: async (e: KeyboardEvent) => {
											if (e.key === "Enter") {
												const newTitle = (e.target as HTMLInputElement).value.trim();
												await renameSessionTitle(newTitle);
											} else if (e.key === "Escape") {
												isEditingTitle = false;
												renderHeader();
											}
										},
									})}
								</div>`
								: html`<button
									class="px-2 py-1 text-sm text-foreground hover:bg-secondary rounded transition-colors"
									@click=${() => {
										isEditingTitle = true;
										renderHeader();
										requestAnimationFrame(() => {
											const input = headerHost?.querySelector('input[type="text"]') as HTMLInputElement;
											if (input) {
												input.focus();
												input.select();
											}
										});
									}}
									title="Click to edit title"
								>
									${currentTitle}
								</button>`
							: ""
					}
				</div>
				<div class="flex items-center gap-1 px-2">
					${Button({
						variant: "ghost",
						size: "sm",
						children: icon(Settings, "sm"),
						onClick: openSettings,
						title: "Settings",
					})}
				</div>
			</div>
	`;

	// Render ONLY the header into its own host. The chat panel and about page are
	// separate, statically-mounted DOM siblings (see initApp) that the host never
	// re-renders.
	render(headerHtml, headerHost);
};

// ============================================================================
// INIT
// ============================================================================
async function initApp() {
	installInstrumentation();

	const app = document.getElementById("app");
	if (!app) throw new Error("App container not found");

	// Build the STATIC scaffold once. #app is the column; the chat panel and the
	// about page are mounted directly as siblings of the header host and are NEVER
	// re-rendered by the host. This is the README's pattern (appendChild the panel
	// once) — the broken example app instead re-rendered the panel inside a lit
	// template, which is what wiped streaming messages.
	app.className = "w-full h-screen flex flex-col bg-background text-foreground overflow-hidden";
	app.replaceChildren();

	headerHost = document.createElement("div");
	headerHost.className = "shrink-0";

	chatPanel = new ChatPanel(); // mounted once, owns its own rendering/scrolling
	chatPanel.classList.add("cw-chat");

	// The gutters flank the centered chat column (term matches left, pipeline
	// activity right) — always present (dedicated space, empty until first use),
	// only dropped on true mobile via the .cw-gutter media query.
	leftGutter = document.createElement("div");
	leftGutter.className = "cw-gutter cw-gutter-left";
	rightGutter = document.createElement("div");
	rightGutter.className = "cw-gutter cw-gutter-right";

	bodyHost = document.createElement("div");
	bodyHost.className = "cw-body";
	bodyHost.append(leftGutter, chatPanel, rightGutter);

	aboutHost = document.createElement("div");
	aboutHost.className = "flex-1 min-h-0 overflow-y-auto";
	render(renderAbout(), aboutHost);

	app.append(headerHost, bodyHost, aboutHost);
	renderGutters(); // initial empty state

	// Voice capture → the SAME agent as typed chat. Batch STT turns mic audio into a
	// transcript; agent.prompt() drives the LLM (inheriting the Design-2 KG
	// retrieval/injection + per-turn ingestion for free); the assistant's streamed
	// text is tapped off the lifecycle listener (above) and spoken via TTS. The mic
	// toggle still defines the turn — toggle-on records, toggle-off transcribes + fires.
	let recorder: PcmRecorder | null = null;
	// Guards the async gap in onStart: the consent/lease awaits happen BEFORE the
	// recorder exists, so a mic toggle-off (onStop) in that window would find recorder ===
	// null and no-op, then onStart would resume and start a recorder nothing ever stops.
	// onStop flips this true; onStart checks it after each await and bails, so no orphaned
	// recorder is created (the mic stream itself is released by the VoiceController's stop()).
	let recordingEpoch = 0;
	let recordingOwner: Agent | null = null;
	let recordingSelection = 0;
	let recordingPlaceholder: AgentMessage | null = null;

	// Lazily build the shared TTS synth: an AudioContext + the audio-output-processor
	// worklet, reused for every voice turn. The context runs at the TTS wire's 24 kHz PCM
	// rate so frames play with no resampling — there is no decoder in the path.
	let synthPending: Promise<KyutaiTtsSynthesizer> | null = null;
	const ensureSynth = async (): Promise<KyutaiTtsSynthesizer> => {
		if (synth) return synth;
		if (synthPending) return synthPending;
		synthPending = (async () => {
		const ctx = new AudioContext({ sampleRate: TTS_SAMPLE_RATE });
		try {
		const outputWorklet = await getAudioWorkletNode(ctx, "audio-output-processor");
		outputWorklet.connect(ctx.destination);
		await ctx.resume();
		// A whole voice turn that produces no audio (TTS backend unreachable) surfaces a
		// toast instead of failing silently to text-only.
		const onVoiceUnavailable = () =>
			showVoiceToast("Voice output is unavailable right now — the reply is text-only.");
		// voiceLease is null on the default (broker-off) path → the synth falls back to
		// VITE_TTS_BASE, exactly as before.
		synth = voiceLease
			? new KyutaiTtsSynthesizer(outputWorklet, { baseUrl: voiceLease.ttsUrl, idleTimeoutMs: releaseProfile().limits.speechTimeoutMs, onVoiceUnavailable, onDispose: () => { outputWorklet.disconnect(); void ctx.close(); } })
			: new KyutaiTtsSynthesizer(outputWorklet, { idleTimeoutMs: releaseProfile().limits.speechTimeoutMs, onVoiceUnavailable, onDispose: () => { outputWorklet.disconnect(); void ctx.close(); } });
		return synth;
		} catch (error) { await ctx.close().catch(() => {}); throw error; }
		})();
		try { return await synthPending; } finally { synthPending = null; }
	};

	// Lazily build + connect the shared STT client. connect() is a no-op when already
	// connected and reconnects when the socket has dropped, so it's safe to call per turn.
	const ensureStt = async (): Promise<WhisperClient> => {
		// Whisper is a SHARED, stateless HTTP endpoint holding no per-session resource,
		// so the broker never leases one — only the TTS endpoint is leased. This client
		// always uses VITE_STT_BASE (connect() is a no-op; HTTP is stateless).
		if (!sttClient) sttClient = new WhisperClient();
		await sttClient.connect();
		return sttClient;
	};

	// Barge-in: cut ONLY the TTS audio (the LLM keeps generating — talking over the
	// agent is fine). Never abort the agent. Shared by the mic-toggle barge-in,
	// Ctrl+Alt+Space, and the stop-audio button.
	const cutVoiceAudio = () => {
		synth?.stop();
		voiceQueue?.close();
		voiceQueue = null;
		voiceTurnCut = true; // don't reopen a speaker for the rest of this turn after a cut
	};

	// --- Voice-broker lease lifecycle (all no-ops when VOICE_BROKER_ENABLED is off) ---

	// Status notices expire; an unsent transcript remains until explicitly dismissed.
	const showVoiceToast = (text: string, recoveredText?: string) => {
		const el = document.createElement("div");
		el.textContent = text;
		el.setAttribute("role", "status");
		el.style.cssText =
			"position:fixed;left:50%;bottom:5rem;transform:translateX(-50%);z-index:9999;" +
			"background:#111;color:#34d399;border:1px solid #34d399;border-radius:.5rem;" +
			"padding:.5rem .9rem;font-size:.875rem;box-shadow:0 2px 12px rgba(0,0,0,.4);";
		document.body.appendChild(el);
		if (recoveredText === undefined) window.setTimeout(() => el.remove(), 4000);
		else {
			el.style.maxWidth = "min(90vw, 40rem)";
			const transcript = document.createElement("textarea");
			transcript.readOnly = true;
			transcript.value = recoveredText;
			transcript.setAttribute("aria-label", "Unsent voice transcript");
			transcript.style.cssText = "display:block;width:100%;min-height:6rem;max-height:50vh;margin-top:.5rem;color:inherit;background:transparent;";
			const dismiss = document.createElement("button");
			dismiss.textContent = "Dismiss transcript";
			dismiss.addEventListener("click", () => el.remove());
			el.append(transcript, dismiss);
		}
	};

	// Drop text into the chat composer (the editor's textarea), appending to whatever's
	// already there. Best-effort: returns false if the textarea isn't found, so the caller
	// can fall back to a toast. Dispatches an input event so the editor's own state tracks it.
	const fillComposer = (textToInsert: string): boolean => {
		const ta = document.querySelector<HTMLTextAreaElement>("message-editor textarea");
		if (!ta) return false;
		const existing = ta.value.trim();
		ta.value = existing ? `${existing} ${textToInsert}` : textToInsert;
		ta.dispatchEvent(new Event("input", { bubbles: true }));
		ta.focus();
		return true;
	};

	const stopVoiceHeartbeat = () => {
		if (voiceHeartbeatTimer !== null) {
			clearInterval(voiceHeartbeatTimer);
			voiceHeartbeatTimer = null;
		}
	};

	// Drop the held lease. useBeacon → fire a navigator.sendBeacon (survives unload);
	// otherwise a keepalive fetch. Safe to call with no lease held.
	const releaseVoiceLease = (useBeacon: boolean) => {
		stopVoiceHeartbeat();
		const lease = voiceLease;
		voiceLease = null;
		if (!lease) return;
		const body = JSON.stringify({ leaseId: lease.leaseId });
		try {
			if (useBeacon && navigator.sendBeacon) {
				navigator.sendBeacon(VOICE_RELEASE_ENDPOINT, new Blob([body], { type: "text/plain" }));
			} else {
				void fetch(VOICE_RELEASE_ENDPOINT, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body,
					keepalive: true,
				}).catch(() => {});
			}
		} catch (err) {
			dbgError("voice lease release failed:", err);
		}
	};

	const startVoiceHeartbeat = (heartbeatSec: number) => {
		stopVoiceHeartbeat();
		const ms = Math.max(5, heartbeatSec) * 1000;
		voiceHeartbeatTimer = setInterval(() => {
			if (!voiceLease) return;
			void fetch(VOICE_HEARTBEAT_ENDPOINT, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ leaseId: voiceLease.leaseId }),
			})
				.then((r) => {
					// 404 → the server reclaimed this lease (TTL); drop it locally so the
					// next mic-on re-leases cleanly.
					if (r.status === 404) releaseVoiceLease(false);
				})
				.catch(() => {});
		}, ms);
	};

	// Acquire (or reuse) a voice slot. Returns:
	//   "skip"    — broker disabled OR the request failed → proceed with default
	//               unbrokered behavior (voice still works if the broker is down).
	//   "granted" — a slot is held (voiceLease set); the synth will use its TTS URL.
	//   "busy"    — every TTS endpoint is full (202) → caller must abort the mic-on.
	const acquireVoiceLease = async (): Promise<"skip" | "granted" | "busy"> => {
		if (!VOICE_BROKER_ENABLED) return "skip";
		if (voiceLease) return "granted"; // already hold this engagement's slot
		let res: Response;
		try {
			res = await fetch(VOICE_LEASE_ENDPOINT, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: "{}",
			});
		} catch (err) {
			dbgError("voice lease request failed:", err);
			return "skip";
		}
		if (res.status === 202) return "busy";
		if (!res.ok) {
			dbgError("voice lease error status:", res.status);
			return "skip";
		}
		let data: ReturnType<typeof voiceLeaseResponse>;
		try {
			data = voiceLeaseResponse(await res.json());
		} catch (err) {
			dbgError("voice lease parse failed:", err);
			return "skip";
		}
		// A freshly-minted lease may point at a different TTS endpoint than the previous
		// one (e.g. after a TTL-drop). Tear down the cached synth so ensureSynth rebuilds
		// it against the leased URL.
		synth?.dispose();
		synth = null;
		voiceLease = { leaseId: data.leaseId, ttsUrl: data.ttsUrl };
		startVoiceHeartbeat(data.heartbeatSec ?? 60);
		return "granted";
	};

	const voiceController = installVoiceCapture({
		onStart: async (stream) => {
			if (sessionLoadPending || chatPanel.agentInterface?.sendDisabled) {
				voiceController.cancel();
				showVoiceToast("Conversation is loading. Try again when it is ready.");
				return;
			}
			const epoch = ++recordingEpoch;
			const owner = agent;
			const selection = sessionSelection;
			recordingSelection = selection;
			const isActive = () => epoch === recordingEpoch && owner === agent && selection === sessionSelection;
			recordingOwner = owner;
			cutVoiceAudio(); // barge-in: toggling the mic on cuts any in-progress reply's audio
			releaseProfile();
			if (!isActive()) return; // toggled off during the modal → no recorder was built
			void ensureMemoryConsent();
			// Voice-concurrency admission (no-op when the broker is disabled). On "busy"
			// every TTS endpoint is full → refuse the mic-on and steer the user to typed
			// chat (which shares the same agent and needs no voice slot).
			const leaseStatus = await acquireVoiceLease();
			if (!isActive()) return; // toggled off during the lease await
			if (leaseStatus === "busy") {
				voiceController.cancel(); // back to idle, release the mic stream, no onStop
				showVoiceToast("Voice is busy right now — type your message instead.");
				return;
			}
			// Recording-in-progress cue: show a user-side placeholder bubble (undulating
			// ellipsis) right away, removed in onStop when the real transcript lands. This
			// is an external edit (no agent event), so poke the view to re-clone.
			const placeholder = createVoicePendingMessage();
			recordingPlaceholder = placeholder;
			owner.state.messages = [...owner.state.messages, placeholder];
			repaintChatAfterExternalEdit();
			try {
				await ensureSynth(); // warm the synth up front so the TTS tap can lazily open a speaker mid-stream
				await ensureStt();
			} catch (err) {
				dbgError("voice setup failed:", err);
			}
			if (!isActive()) {
				// Toggled off during setup — drop the placeholder and start no recorder.
				owner.state.messages = owner.state.messages.filter((m) => m !== placeholder);
				if (owner === agent) repaintChatAfterExternalEdit();
				return;
			}
			const rec = new PcmRecorder({ stream });
			recorder = rec;
			try { await rec.start(); } catch (error) {
				if (recorder === rec) recorder = null;
				owner.state.messages = owner.state.messages.filter((m) => m !== placeholder);
				if (owner === agent) repaintChatAfterExternalEdit();
				throw error;
			}
			// Toggled off during recorder.start(): if onStop already claimed this recorder
			// (recorder !== rec — it nulled it to transcribe a complete quick turn), it owns
			// teardown; otherwise the toggle landed in this window with no recorder to stop, so
			// tear the just-started one down here rather than leak it.
			if (!isActive() && recorder === rec) {
				await rec.stop().catch(() => {});
				recorder = null;
			}
		},
		// Mic toggle OFF = end of turn. Stop the recorder, transcribe the whole utterance
		// (batch STT — no settle-wait needed, the full utterance is captured), then hand
		// the transcript to agent.prompt() with the TTS gate armed so the reply speaks.
		// agent.prompt adds the user message and streams the assistant reply; ChatPanel
		// renders both — no manual message append.
		onStop: async () => {
			const epoch = ++recordingEpoch;
			const owner = recordingOwner;
			const selection = recordingSelection;
			const placeholder = recordingPlaceholder;
			recordingOwner = null;
			recordingPlaceholder = null;
			const isActive = () => epoch === recordingEpoch && owner === agent && selection === sessionSelection;
			// Keep the recording-in-progress placeholder visible THROUGH the STT round-trip:
			// batch transcription takes multiple seconds, and dropping the cue up front would
			// leave dead air with no feedback during exactly that wait. The same ellipsis
			// bubble carries continuous record→transcribe→answer feedback. It's removed
			// exactly once — right before the real transcript bubble lands, and via the
			// finally as a safety net on every early-return / error path, so it is NEVER
			// orphaned. The guard makes the helper idempotent.
			let placeholderShown = true;
			const dropPlaceholder = () => {
				if (!placeholderShown) return;
				placeholderShown = false;
				if (owner) owner.state.messages = owner.state.messages.filter((m) => m !== placeholder);
				if (owner === agent) repaintChatAfterExternalEdit();
			};
			try {
				const rec = recorder;
				recorder = null;
				if (!rec) return;
				let pcm: Float32Array;
				try {
					pcm = await rec.stop();
				} catch (err) {
					dbgError("voice recorder stop failed:", err);
					return;
				}
				if (!pcm.length || !sttClient) return;
				let transcript = "";
				while (isActive()) {
					try { transcript = await sttClient.transcribe(pcm); break; }
					catch (err) {
						dbgError("voice transcription failed:", err);
						if (!isActive() || !confirm("Transcription failed. Retry this recording? Cancel discards it.")) return;
					}
				}
				if (!isActive()) return;
				// Speech-adaptation pass: the lexicon's auto-replace rules rewrite known
				// mistranscriptions before the transcript reaches the display or the model.
				const rawTranscript = transcript;
				const rules = memoryConsent === "granted" ? pipeline.getSttLexicon().autoReplace : [];
				if (rules.length) {
					const fixed = applyAutoReplace(transcript, rules);
					if (fixed !== transcript) {
						dbg(`auto-replace rewrote transcript: "${transcript}" → "${fixed}"`);
						transcript = fixed;
					}
				}
				pendingVoiceEvidence = memoryConsent === "granted" ? { utteranceId: crypto.randomUUID(), rawText: rawTranscript, correctedText: transcript } : undefined;
				// Real transcript is in hand — drop the cue right before the user bubble lands
				// (avoids a flash) and hand the transcript to the agent.
				dropPlaceholder();
				if (transcript.trim()) {
					// Barge-in coherence: if a run is still generating (the user spoke over the
					// reply and toggled off before it finished), don't fire a second agent.prompt —
					// two runs can't share the turn globals coherently, so it would clobber the live
					// turn's speak state. The barge-in already cut the audio (cutVoiceAudio in
					// onStart); drop this send rather than corrupt the in-flight turn.
					if (runInFlight) {
						// The user paid for this STT, so never silently drop it: park the transcript
						// in the composer (fall back to a toast if the editor textarea isn't found) so
						// they can send it once the current reply finishes.
						dbgWarn("voice barge-in while a run is in flight — transcript parked, not sent");
						if (!fillComposer(transcript)) {
							showVoiceToast("Heard while replying. Copy your transcript before dismissing.", transcript);
						}
						return; // finally still runs dropPlaceholder (already dropped — idempotent)
					}
					voiceTurnSeq++; // stamp this turn so its agent_end retires the right speak state
					voiceTurnSpeaking = true; // gate: this turn's reply speaks, incl. the post-tool final answer (see TTS tap)
					voiceTurnCut = false; // fresh turn — clear any prior barge-in guard
					const sendingTurn = voiceTurnSeq;
					const voiceMessage: AgentMessage = { role: "user", content: transcript, timestamp: Date.now() };
					void sendWithAdmission(owner!, voiceMessage, () => {}, () => {
						if (owner === agent && selection === sessionSelection) {
							if (fillComposer(transcript)) showVoiceToast("Message could not be sent. Your transcript is in the composer.");
							else showVoiceToast("Message could not be sent. Copy your transcript before dismissing.", transcript);
						} else showVoiceToast("Message could not be sent in its original conversation. Copy your transcript before dismissing.", transcript);
						if (owner === agent && sendingTurn === voiceTurnSeq) {
							voiceTurnSpeaking = false;
							inFlightVoiceTurn = null;
							inFlightVoiceEvidence = undefined;
						}
					}).catch((err) => {
						dbgError("voice agent.prompt failed:", err);
					});
				}
			} finally {
				dropPlaceholder(); // safety net: every early-return / error path lands here
			}
		},
	});

	// Ctrl+Alt+Space = "shut up": cut the assistant's TTS without recording. (Ctrl+Space,
	// the mic toggle, also barges in — it cuts TTS on its way to recording, see onStart.)
	// The guard mirrors voice.ts's Ctrl+Space (which requires !altKey), so they never collide.
	window.addEventListener("keydown", (e) => {
		if (e.code === "Space" && e.ctrlKey && e.altKey && !e.metaKey && !e.shiftKey) {
			e.preventDefault();
			cutVoiceAudio();
		}
	});

	// Tear the voice legs down on page unload. A pipeline tick in flight simply
	// dies with the page — the previous turn's tick already persisted everything,
	// and per-turn firing is exactly what bounds the loss to one turn.
	window.addEventListener("beforeunload", () => {
		releaseVoiceLease(true); // free the voice slot on tab close (sendBeacon; no-op if none held)
		synth?.dispose();
		sttClient?.close();
	});

	// Memory consent + the indicator button. Load the saved opt-in first so the
	// first turn's pipeline gate is correct, then mount the button (reflects consent
	// + pipeline activity; click offers opt-in when off).
	await loadMemoryConsent();
	const onMemoryClick = () => {
		if (memoryConsent === "granted" && pipeline?.hasFailedWork) { pipeline.retryPending(); return; }
		if (memoryConsent !== "granted") {
			void (async () => setMemoryConsent(await showConsentModal()))();
		}
	};
	const memoryButton = installMemoryButton({
		getVisual: () => {
			if (memoryConsent !== "granted") return "off";
			// `pipeline?` — the button mounts before the pipeline is constructed a few
			// lines below; until then it just reads as idle ("saved").
			return pipeline?.isRunning ? "running" : pipeline?.hasFailedWork ? "failed" : "saved";
		},
		onClick: onMemoryClick,
	});
	refreshMemoryUi = () => memoryButton.refresh();

	// Stop-audio button (leftmost in the cluster): single click cuts the current reply's
	// audio (Ctrl+Alt+Space), double click toggles a persistent mute.
	const stopAudioButton = installStopAudioButton({
		onCut: () => cutVoiceAudio(),
		onToggleMute: () => {
			ttsMuted = !ttsMuted;
			localStorage.setItem(TTS_MUTE_KEY, ttsMuted ? "1" : "0");
			if (ttsMuted) cutVoiceAudio(); // enabling mute also cuts any audio in flight
			stopAudioButton.refresh();
		},
		isMuted: () => ttsMuted,
	});

	try { await loadUserGraph(); } catch {
		memoryConsent = "declined";
		alert("Saved memory could not be loaded. Memory is disabled; existing data has been retained. Reload to retry.");
	}

	// The per-turn memory pipeline. Constructed after the graph loads; its state
	// (action buffers, running context, speech data, flags) loads in init().
	pipeline = new PipelineRuntime({
		backend,
		getRawHistory: async (sessionKey: string) => {
			const saved = await storage.sessions.get(sessionKey);
			if (saved === null) return null;
			if (!saved.rawHistory) throw new Error("Original conversation history is unavailable");
			return { revision: saved.revision ?? 0, archive: saved.rawHistory };
		},
		getGraph: () => userGraph,
		setGraph: (graph) => { userGraph = graph; },
		publishMemory: async (graph, snapshot, archive, assertActive) => {
			if (!graphLoaded) throw new Error("Memory has not loaded");
			await writeMemory({ graph, pipeline: snapshot, ...(archive ? { archive } : {}) }, assertActive);
		},
		appendArchive: (records: MemoryArchiveRecord[], assertActive?: () => void) => writeMemory({ archive: records }, assertActive),
		readArchive: (query: MemoryArchiveQuery, assertActive?: () => void) => memoryStorage.readArchive(query, assertActive),
		onError: reportMemoryFailure,
		embed: makeEmbedClient({
			endpoint: EMBED_ENDPOINT,
			getBearer: () => "",
		}),
		phonemize: makePhonemizeClient({ endpoint: `${MYRIAPOD_PROXY_BASE}/phonemize`, getBearer: () => "" }),
		getModel: () => servingPath.model,
		getBaseUrl: () => servingPath.baseUrl,
		getModelId: () => servingPath.model.id,
		getAuth: () => servingPath.auth,
		// The current memory-consent state, so the pipeline agent can re-check before it
		// persists (consent can be revoked between a turn ending and its tick running).
		getConsent: () => graphLoaded && !memoryReplacing && !memoryStorage.invalidated ? memoryConsent : "declined",
		addCost: addIngestionCostToSession,
		onStateChange: () => refreshMemoryUi(),
		onActivity: () => renderGutters(),
	});
	try {
		if (!memorySnapshot) throw new Error("Saved memory snapshot unavailable");
		pipeline.loadSnapshot(memorySnapshot);
	} catch {
		memoryConsent = "declined";
		alert("Saved memory could not be loaded. Memory is disabled; existing data has been retained. Reload to retry.");
	}
	renderGutters(); // re-render with the seeded activity feed

	// PersistentStorageDialog is broken upstream — export/import (Memory settings
	// tab) is the durability story instead.

	const urlParams = new URLSearchParams(window.location.search);
	const sessionIdFromUrl = urlParams.get("session");

	if (sessionIdFromUrl) {
		const loaded = await loadSession(sessionIdFromUrl);
		if (!loaded) {
			// Session doesn't exist — start a fresh chat in place (no reload).
			await newSession();
		}
	} else {
		await createAgent();
	}

	updateBodyVisibility();
	await chatPanel.updateComplete;
	await chatPanel.agentInterface?.updateComplete;
	await chatPanel.agentInterface?.querySelector<MessageEditor>("message-editor")?.updateComplete;
	quickStartTour = new QuickStartTour();
	renderHeader();
	quickStartTour.startIfNew();
}

initApp().catch((error) => {
	dbgError("Application initialization failed", error);
	const notice = document.createElement("div"); notice.setAttribute("role", "alert");
	notice.className = "p-4"; notice.textContent = error instanceof Error ? error.message : String(error);
	document.body.appendChild(notice);
});
