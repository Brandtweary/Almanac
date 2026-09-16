// Runtime contracts at hosted-service boundaries. Invalid successes must not enter
// credential storage, billing displays, or voice transport state.
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
export function grantToken(value: unknown): string {
	return text(record(value).token, "grant token");
}
export function hostedBalance(value: unknown): { tier: string; remaining: number; grant: number } {
	const data = record(value);
	return { tier: text(data.tier, "balance tier"), remaining: nonnegative(data.remaining, "balance"), grant: nonnegative(data.grant, "grant") };
}
export function voiceLeaseResponse(value: unknown): { leaseId: string; ttsUrl: string; heartbeatSec: number } {
	const data = record(value);
	const leaseId = text(data.leaseId, "lease ID");
	const ttsUrl = text(data.ttsUrl, "TTS URL");
	const protocol = new URL(ttsUrl).protocol;
	if (protocol !== "ws:" && protocol !== "wss:") throw new Error("invalid TTS WebSocket URL");
	const heartbeatSec = data.heartbeatSec === undefined ? 60 : nonnegative(data.heartbeatSec, "heartbeat");
	if (heartbeatSec <= 0) throw new Error("invalid heartbeat");
	return { leaseId, ttsUrl, heartbeatSec };
}
export function serviceError(value: unknown, fallback: string): string {
	return value && typeof value === "object" && "error" in value && typeof value.error === "string" ? value.error : fallback;
}
