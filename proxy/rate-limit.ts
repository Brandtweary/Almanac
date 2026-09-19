/** Per-client admission windows for the publicly reachable gateway routes.
 *
 * Every route below is open to any origin, so the sliding window is the only
 * admission control between a visitor and a shared local resource: one encoder,
 * one corpus service, one search upstream, one inference server. Counts are
 * in-memory and per gateway instance; a restart resets them.
 */
import type { Context } from "hono";
import { getConnInfo } from "hono/bun";

export const WINDOW_MS = 60_000;

/** Requests per client per minute. Sized above the busiest single-visitor turn
 *  measured in the browser client, not at the upstream's capacity. */
export const ROUTE_LIMITS = {
	completions: 30,
	tokenize: 120,
	corpus: 60,
	source: 120,
	embed: 240,
	webSearch: 40,
	phonemize: 120,
	speech: 20,
	voice: 60,
	// A form submitted by hand, so the window is sized for a visitor correcting
	// a typo rather than for any rate of legitimate traffic.
	signup: 5,
} as const;
export type RouteName = keyof typeof ROUTE_LIMITS;

const MAX_TRACKED_CLIENTS = 20_000;

/** The client address used for per-client limits. `X-Forwarded-For` is honoured
 *  only when the direct socket peer is a trusted proxy, and only its rightmost
 *  entry — everything to the left of that is client-supplied and spoofable. */
export function clientIp(c: Context, trustedProxies: string[]): string {
	let peer = "unknown";
	try { peer = getConnInfo(c).remote.address ?? "unknown"; } catch { peer = "unknown"; }
	if (trustedProxies.includes("*") || trustedProxies.includes(peer)) {
		const parts = (c.req.header("x-forwarded-for") ?? "").split(",").map(s => s.trim()).filter(Boolean);
		if (parts.length) return parts[parts.length - 1]!;
	}
	return peer;
}

export class RateLimiter {
	private hits = new Map<string, number[]>();
	private sweptAt = Date.now();
	constructor(private readonly max: number, private readonly windowMs: number = WINDOW_MS) {}
	/** Records the attempt and reports whether it exceeds the window. */
	limited(client: string): boolean {
		const now = Date.now();
		if (now - this.sweptAt > this.windowMs || this.hits.size > MAX_TRACKED_CLIENTS) this.sweep(now);
		const live = (this.hits.get(client) ?? []).filter(t => t > now - this.windowMs);
		live.push(now);
		this.hits.set(client, live);
		return live.length > this.max;
	}
	private sweep(now: number) {
		this.sweptAt = now;
		for (const [client, times] of this.hits) {
			const live = times.filter(t => t > now - this.windowMs);
			if (live.length) this.hits.set(client, live);
			else this.hits.delete(client);
		}
	}
}

export function createLimiters(): Record<RouteName, RateLimiter> {
	return Object.fromEntries(Object.entries(ROUTE_LIMITS)
		.map(([name, max]) => [name, new RateLimiter(max)])) as Record<RouteName, RateLimiter>;
}
