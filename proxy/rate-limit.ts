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

/** The identity a per-client window counts against. An IPv6 address is reduced
 *  to its /64, the smallest block routinely assigned to a single subscriber or
 *  host, so one machine cannot present itself as unbounded distinct clients.
 *  An IPv4-mapped IPv6 address counts as its IPv4 address. Anything that does
 *  not parse as IPv6 is used verbatim. */
export function rateLimitKey(address: string): string {
	const bare = address.split("%")[0]!.toLowerCase();
	if (!bare.includes(":")) return bare;
	// An embedded dotted-quad tail fills the last two groups.
	const hex = bare.replace(/:(\d{1,3}(?:\.\d{1,3}){3})$/, (_match, tail: string) => {
		const bytes = tail.split(".").map(Number);
		if (bytes.some(value => value > 255)) return _match;
		return `:${((bytes[0]! << 8) | bytes[1]!).toString(16)}:${((bytes[2]! << 8) | bytes[3]!).toString(16)}`;
	});
	const halves = hex.split("::");
	if (halves.length > 2) return bare;
	const head = halves[0] ? halves[0].split(":") : [];
	const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
	const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
	if (fill < 0) return bare;
	const groups = [...head, ...Array<string>(fill).fill("0"), ...tail];
	if (groups.length !== 8 || !groups.every(g => /^[0-9a-f]{1,4}$/.test(g))) return bare;
	const values = groups.map(g => parseInt(g, 16));
	if (values.slice(0, 5).every(value => value === 0) && values[5] === 0xffff) {
		return [values[6]! >> 8, values[6]! & 255, values[7]! >> 8, values[7]! & 255].join(".");
	}
	return `${values.slice(0, 4).map(value => value.toString(16)).join(":")}::/64`;
}

export class RateLimiter {
	/** Clients in order of their most recent attempt, so every client whose
	 *  window has fully expired sits at the front and is evicted from there. */
	private hits = new Map<string, number[]>();
	constructor(private readonly max: number, private readonly windowMs: number = WINDOW_MS) {}
	/** Records the attempt and reports whether it exceeds the window. */
	limited(client: string): boolean {
		const now = Date.now();
		const horizon = now - this.windowMs;
		for (const [key, times] of this.hits) {
			if (times[times.length - 1]! > horizon) break;
			this.hits.delete(key);
		}
		const tracked = this.hits.get(client);
		// A full table holds only clients active within the window. A newcomer is
		// refused without being recorded, so the refusal lasts exactly until the
		// least recently active client expires and frees a slot.
		if (!tracked && this.hits.size >= MAX_TRACKED_CLIENTS) return true;
		const live = (tracked ?? []).filter(t => t > horizon);
		live.push(now);
		// Older attempts cannot affect admission while max + 1 newer attempts
		// remain. Keeping the newest ones includes denials and preserves expiry.
		if (live.length > this.max + 1) live.shift();
		this.hits.delete(client);
		this.hits.set(client, live);
		return live.length > this.max;
	}
}

export function createLimiters(): Record<RouteName, RateLimiter> {
	return Object.fromEntries(Object.entries(ROUTE_LIMITS)
		.map(([name, max]) => [name, new RateLimiter(max)])) as Record<RouteName, RateLimiter>;
}
