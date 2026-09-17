import { resolve } from "node:path";
export const config = {
  qualificationBoundary: process.env.QUALIFICATION_BOUNDARY ?? "",
  qualificationMode: process.env.QUALIFICATION_MODE === "1",
  host: process.env.HOST ?? "127.0.0.1",
  port: Number(process.env.PORT ?? 8790),
  llmBase: process.env.LLM_BASE ?? "",
  contentBase: process.env.CONTENT_BASE ?? "http://127.0.0.1:8791",
  searxngBase: process.env.SEARXNG_BASE ?? "http://127.0.0.1:8888",
  embedBase: process.env.EMBED_BASE ?? "http://127.0.0.1:8899",
  sttBase: process.env.STT_BASE ?? "",
  ttsBase: process.env.VOICE_TTS_BASE ?? "",
  profilePath: process.env.RELEASE_PROFILE ?? "",
  frontendDir: resolve(process.env.FRONTEND_DIR ?? `${import.meta.dir}/../dist`),
  logPath: process.env.GATEWAY_LOG ?? `${import.meta.dir}/gateway.jsonl`,
  allowedOrigins: (process.env.ALLOWED_ORIGIN ?? "http://localhost:5173").split(","),
};
export type GatewayConfig = typeof config;
export interface ReleaseProfile {
  id: string; qualified: boolean; receipts: string[];
  roles: Record<string, {maxInputTokens: number; maxOutputTokens: number; maxStageOutputTokens?: number; thinkingLevel?: string}>;
  model: {id: string; name: string; contextWindow: number; maxTokens: number; reasoning: boolean; input: ("text" | "image")[];
    excludeToolsWhenNone?: boolean; artifactDigest: string; tokenizerDigest: string; templateDigest: string; parser: string; quantization: string;
    sampling?: {temperature:number;top_p:number;top_k:number}};
  limits: {queueCapacity: number; queueTimeoutMs: number; executionTimeoutMs: number; maxRequestBytes: number;
    backgroundMaxTokens: number; speechConcurrency: number; speechTimeoutMs: number; speechMaxBytes: number};
}
export function validateProfile(value: unknown, allowCandidate = false): ReleaseProfile {
  const p = value as ReleaseProfile;
  if (!p || (p.qualified !== true && !(allowCandidate && p.qualified === false)) || !p.id || !Array.isArray(p.receipts) || (p.qualified && !p.receipts.length) || p.receipts.some(x => typeof x !== "string" || !x))
    throw new Error("release profile lacks qualification receipts");
  for (const key of ["id", "name", "artifactDigest", "tokenizerDigest", "templateDigest", "parser", "quantization"] as const)
    if (typeof p.model?.[key] !== "string" || !p.model[key]) throw new Error(`missing model ${key}`);
  for (const key of ["artifactDigest", "tokenizerDigest", "templateDigest"] as const)
    if (!/^(sha256:)?[a-f0-9]{64}$/i.test(p.model[key])) throw new Error(`invalid model ${key}`);
  if (!Array.isArray(p.model.input) || !p.model.input.length || p.model.input.some(x => !["text", "image"].includes(x)) || typeof p.model.reasoning !== "boolean") throw new Error("invalid model modalities");
  for (const n of [p.model.contextWindow, p.model.maxTokens, ...["queueCapacity", "queueTimeoutMs", "executionTimeoutMs", "maxRequestBytes", "backgroundMaxTokens", "speechConcurrency", "speechTimeoutMs", "speechMaxBytes"].map(k => p.limits?.[k as keyof ReleaseProfile["limits"]])])
    if (!Number.isSafeInteger(n) || n < 1) throw new Error("invalid qualified resource limit");
  if (p.model.maxTokens >= p.model.contextWindow || p.limits.backgroundMaxTokens > p.model.maxTokens) throw new Error("inconsistent token budgets");
  const sampling = p.model.sampling;
  if (sampling !== undefined && (!sampling || typeof sampling !== "object" || Array.isArray(sampling) ||
    !Number.isFinite(sampling.temperature) || sampling.temperature < 0 || sampling.temperature > 2 ||
    !Number.isFinite(sampling.top_p) || sampling.top_p <= 0 || sampling.top_p > 1 ||
    !Number.isSafeInteger(sampling.top_k) || (sampling.top_k !== -1 && sampling.top_k < 1))) throw new Error("invalid candidate sampling policy");
  for (const role of ["chat", "audit", "memory", "summary", "compaction"]) {
    const budget = p.roles?.[role];
    if (["audit", "memory", "summary"].includes(role) && (!Number.isSafeInteger(budget?.maxStageOutputTokens) || budget.maxStageOutputTokens! < 1)) throw new Error(`invalid cumulative stage budget ${role}`);
    if (!budget || !Number.isSafeInteger(budget.maxInputTokens) || budget.maxInputTokens < 1 || !Number.isSafeInteger(budget.maxOutputTokens) || budget.maxOutputTokens < 1 || budget.maxOutputTokens > p.model.maxTokens || budget.maxInputTokens + budget.maxOutputTokens > p.model.contextWindow) throw new Error(`invalid role budget ${role}`);
  }
  return p;
}
