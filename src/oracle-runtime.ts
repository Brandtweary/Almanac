import type { StreamFn } from "@earendil-works/pi-agent-core";
import { streamSimple } from "./pi-ai-slim-compat.js";
import { MYRIAPOD_MODEL, MYRIAPOD_PROXY_BASE, releaseProfile, type OracleRole } from "./myriapod-model.js";

export interface RequestState { id: string; state: string; position?: number; role: OracleRole }
const listeners = new Set<(state: RequestState) => void>();
export function subscribeRequests(fn: (state: RequestState) => void): () => void { listeners.add(fn); return () => listeners.delete(fn); }
function emit(state: RequestState): void { for (const fn of listeners) fn(state); }
export async function countRequestTokens(payload: unknown, role: OracleRole, signal?: AbortSignal): Promise<number> {
	const response = await fetch(`${MYRIAPOD_PROXY_BASE}/tokenize`, {
		method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...(payload as object), role }), signal,
	});
	if (!response.ok) throw new Error(`Context measurement unavailable (HTTP ${response.status}); request was not sent`);
	const result = await response.json();
	if (!Number.isSafeInteger(result.tokens) || result.tokens < 0) throw new Error("Invalid tokenizer result");
	return result.tokens;
}
export async function admitPayload(payload: unknown, role: OracleRole, signal?: AbortSignal): Promise<unknown> {
	const p = releaseProfile();
	const budget = p.roles[role];
	const proposed = payload as { max_tokens?: unknown; max_completion_tokens?: unknown };
	const output = proposed.max_tokens ?? proposed.max_completion_tokens ?? budget.maxOutputTokens;
	if (typeof output !== "number" || !Number.isSafeInteger(output) || output <= 0 || output > budget.maxOutputTokens) throw new Error(`Invalid ${role} output budget`);
	const admitted: Record<string, unknown> = { ...(payload as object), ...p.model.sampling, model: p.model.id, max_tokens: output };
	delete admitted.max_completion_tokens;
	const tokens = await countRequestTokens(admitted, role, signal);
	if (tokens > budget.maxInputTokens) throw new Error(`Context is too large for the local model (${tokens}/${budget.maxInputTokens} input tokens). Start a new chat or reduce the attached material.`);
	return admitted;
}
export function beginRequest(role: OracleRole, conversationId: string, signal?: AbortSignal) {
	signal?.throwIfAborted();
	const id = crypto.randomUUID();
	const endpoint = `${MYRIAPOD_PROXY_BASE}/requests/${id}`;
	let stopped = false;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const cancel = () => { void fetch(endpoint, { method: "DELETE", keepalive: true }).catch(() => {}); emit({ id, role, state: "interrupted" }); };
	const poll = async () => {
		try {
			const res = await fetch(endpoint, { signal: AbortSignal.timeout(5000) });
			if (res.ok && !stopped) { const data = await res.json(); emit({ id, role, ...data }); }
		} catch { /* Completion transport owns terminal failure reporting. */ }
		if (!stopped) timer = setTimeout(poll, 750);
	};
	emit({ id, role, state: "waiting" });
	signal?.addEventListener("abort", cancel, { once: true });
	timer = setTimeout(poll, 250);
	return {
		headers: { "X-Request-Id": id, "X-Conversation-Id": conversationId, "X-Request-Priority": role === "chat" || role === "compaction" ? "foreground" : "background", "X-Request-Role": role },
		finish(state: string) { stopped = true; clearTimeout(timer); signal?.removeEventListener("abort", cancel); emit({ id, role, state }); },
	};
}
export function createLocalStreamFn(role: OracleRole, getConversationId: () => string, getRemainingOutputTokens?: () => number, onAdmitted?: (requestId: string) => void | Promise<void>): StreamFn {
	return async (model, context, options) => {
		const p = releaseProfile();
		const remaining = getRemainingOutputTokens?.() ?? p.roles[role].maxOutputTokens;
		if (!Number.isSafeInteger(remaining) || remaining <= 0) throw new Error("Stage output budget exhausted");
		const outputBudget = Math.min(p.roles[role].maxOutputTokens, remaining);
		const request = beginRequest(role, getConversationId(), options?.signal);
		let failure = "failed";
		try {
			const stream = streamSimple(model, context, { ...options, apiKey: "local", reasoning: p.roles[role].thinkingLevel, headers: { ...options?.headers, ...request.headers, Authorization: null }, maxTokens: outputBudget,
				onResponse: async (response, m) => { if (response.status === 429 || response.status === 503) failure = "busy"; if (response.status >= 200 && response.status < 300) await onAdmitted?.(request.headers["X-Request-Id"]); await options?.onResponse?.(response, m); },
				maxRetries: 0, timeoutMs: p.limits.queueTimeoutMs + p.limits.executionTimeoutMs,
				onPayload: async (payload, m) => admitPayload(await options?.onPayload?.(payload, m) ?? payload, role, options?.signal),
			});
			void stream.result().then(result => request.finish(result.stopReason === "error" ? failure : result.stopReason === "aborted" ? "interrupted" : result.stopReason === "length" ? "incomplete" : "complete"), () => request.finish("failed"));
			return stream;
		} catch (error) { request.finish("failed"); throw error; }
	};
}

/** Ask the installed provider serializer for its exact wire payload without sending it. */
export async function serializeModelRequest(context: Parameters<StreamFn>[1], role: OracleRole = "chat"): Promise<unknown> {
	let captured: unknown;
	const stream = streamSimple(MYRIAPOD_MODEL, context, {
		apiKey: "local", reasoning: releaseProfile().roles[role].thinkingLevel, maxTokens: releaseProfile().roles[role].maxOutputTokens, maxRetries: 0,
		onPayload(payload) { captured = payload; throw new Error("Local serialization capture"); },
	});
	const result = await stream.result();
	if (!captured) throw new Error(`Could not serialize model context: ${result.errorMessage ?? result.stopReason}`);
	return captured;
}
