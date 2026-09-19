import type { Model, ThinkingLevel } from "@earendil-works/pi-ai";
import { appPath, absoluteServiceUrl } from "./app-paths.js";

const ENV = (import.meta.env ?? {}) as Record<string, string | undefined>;
export const GATEWAY_BASE = absoluteServiceUrl(ENV.VITE_PROXY_BASE ?? appPath("v1"));
export const GATEWAY_PROVIDER = "local-oracle";
export type OracleRole = "chat" | "audit" | "memory" | "summary" | "compaction";
export interface RoleBudget { maxInputTokens: number; maxOutputTokens: number; maxStageOutputTokens?: number; thinkingLevel?: ThinkingLevel }
export interface ReleaseProfile {
	id: string;
	model: { id: string; name: string; contextWindow: number; maxTokens: number; reasoning: boolean; input: ("text" | "image")[]; reasoningEffort?: string; sampling?: { temperature: number; top_p: number; top_k: number } };
	roles: Record<OracleRole, RoleBudget>;
	limits: { queueTimeoutMs: number; executionTimeoutMs: number; speechTimeoutMs?: number };
}
let profile: ReleaseProfile | undefined;
export let qualificationMode = false;
export let LOCAL_MODEL_ID = "unconfigured";
export let LOCAL_REASONING_EFFORT: string | undefined;
export let LOCAL_THINKING_LEVEL: ThinkingLevel | "off" = "off";
export let LOCAL_MODEL: Model<"openai-completions"> = {
	id: "unconfigured", name: "Local model unavailable", api: "openai-completions", provider: GATEWAY_PROVIDER,
	baseUrl: GATEWAY_BASE, reasoning: false, input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 0, maxTokens: 0,
};
export function releaseProfile(): ReleaseProfile {
	if (!profile) throw new Error("The local runtime has no qualified release profile. Complete installation before sending a request.");
	return profile;
}
export function validateProfile(value: unknown): ReleaseProfile {
	const p = value as ReleaseProfile;
	const positive = (v: unknown) => typeof v === "number" && Number.isSafeInteger(v) && v > 0;
	if (!p || typeof p.id !== "string" || !p.id || !p.model || typeof p.model.id !== "string" || !p.model.id ||
		typeof p.model.name !== "string" || typeof p.model.reasoning !== "boolean" ||
		!positive(p.model.contextWindow) || !positive(p.model.maxTokens) || !Array.isArray(p.model.input) || !p.model.input.length ||
		p.model.input.some(v => v !== "text" && v !== "image") || !positive(p.limits?.queueTimeoutMs) || !positive(p.limits?.executionTimeoutMs)) {
		throw new Error("Local runtime returned an invalid release profile");
	}
	const sampling = p.model.sampling;
	if (sampling !== undefined && (!sampling || typeof sampling !== "object" || Array.isArray(sampling) ||
		!Number.isFinite(sampling.temperature) || sampling.temperature < 0 || sampling.temperature > 2 ||
		!Number.isFinite(sampling.top_p) || sampling.top_p <= 0 || sampling.top_p > 1 ||
		!Number.isSafeInteger(sampling.top_k) || (sampling.top_k !== -1 && sampling.top_k < 1))) throw new Error("Invalid candidate sampling policy");
	for (const role of ["chat", "audit", "memory", "summary", "compaction"] as const) {
		const b = p.roles?.[role];
		if (["audit", "memory", "summary"].includes(role) && !positive(b?.maxStageOutputTokens)) throw new Error(`Invalid ${role} cumulative stage output budget`);
		if (!b || !positive(b.maxInputTokens) || !positive(b.maxOutputTokens) || b.maxInputTokens + b.maxOutputTokens > p.model.contextWindow || b.maxOutputTokens > p.model.maxTokens) throw new Error(`Invalid ${role} context budget in release profile`);
	}
	return p;
}
export async function loadReleaseProfile(): Promise<void> {
	const res = await fetch(`${GATEWAY_BASE}/profile`, { signal: AbortSignal.timeout(10000) });
	if (!res.ok) throw new Error(`Local runtime unavailable (HTTP ${res.status})`);
	const data = await res.json();
	qualificationMode = data.qualificationMode === true;
	if (!data.ready && !qualificationMode) throw new Error(`Local oracle is not ready: ${data.status ?? "missing corpus or release profile"}`);
	profile = validateProfile(data.profile);
	LOCAL_MODEL_ID = profile.model.id;
	LOCAL_REASONING_EFFORT = profile.model.reasoningEffort;
	LOCAL_THINKING_LEVEL = profile.roles.chat.thinkingLevel ?? "off";
	LOCAL_MODEL = { ...LOCAL_MODEL, ...profile.model, maxTokens: profile.roles.chat.maxOutputTokens };
}
export function proxyChatModel(): Model<"openai-completions"> { return { ...LOCAL_MODEL }; }
