import { resolveSpeechEndpoint } from "./app-paths.js";
// Validate speech-service responses before opening a transport.
function record(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid service response");
	return value as Record<string, unknown>;
}
function text(value: unknown, field: string): string {
	if (typeof value !== "string" || !value.trim()) throw new Error(`invalid ${field}`);
	return value;
}
function nonnegative(value: unknown, field: string): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new Error(`invalid ${field}`);
	return value;
}
export function voiceLeaseResponse(value: unknown): { leaseId: string; ttsUrl: string; heartbeatSec: number } {
	const data = record(value);
	const leaseId = text(data.leaseId, "lease ID");
	const ttsUrl = text(data.ttsUrl, "TTS URL");
	const resolvedTtsUrl = resolveSpeechEndpoint(ttsUrl);
	const heartbeatSec = data.heartbeatSec === undefined ? 60 : nonnegative(data.heartbeatSec, "heartbeat");
	if (heartbeatSec <= 0) throw new Error("invalid heartbeat");
	return { leaseId, ttsUrl: resolvedTtsUrl, heartbeatSec };
}
export function serviceError(value: unknown, fallback: string): string {
	return value && typeof value === "object" && "error" in value && typeof value.error === "string" ? value.error : fallback;
}
