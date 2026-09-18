import { randomBytes } from "node:crypto";

export interface TtsEndpoint {
	ttsUrl: string;
}

export interface VoiceBrokerConfig {
	endpoints: TtsEndpoint[];
	// Max concurrent voice sessions per TTS endpoint. A lease is held for a whole
	// narration turn, so this is a count of simultaneous speakers, not of requests.
	capacity: number;
	// How often the browser should heartbeat (seconds). A lease is TTL-reclaimed
	// once its last beat is older than 3x this (covers tabs that closed without a
	// clean release).
	heartbeatSec: number;
	// Injectable clock (ms) — tests drive the TTL sweeper through it.
	now?: () => number;
}

interface Lease {
	endpointIdx: number;
	lastBeat: number;
}

export type LeaseResult =
	| { granted: true; leaseId: string; ttsUrl: string; heartbeatSec: number }
	| { granted: false; queued: true; position: number };

export class VoiceBroker {
	private readonly leases = new Map<string, Lease>();
	// Per-endpoint active lease count, indexed like cfg.endpoints.
	private readonly active: number[];
	// Timestamps of recent overflow (202) responses, swept on the heartbeat TTL.
	// Used only to give a queued caller an approximate "position" — the broker keeps
	// no real waiter list (a refused caller is told to type instead, not parked).
	private overflow = 0;
	private readonly now: () => number;

	constructor(private readonly cfg: VoiceBrokerConfig) {
		if (cfg.endpoints.length === 0) throw new Error("VoiceBroker needs at least one TTS endpoint");
		if (!Number.isSafeInteger(cfg.capacity) || cfg.capacity < 1) throw new Error("VoiceBroker capacity must be a positive safe integer");
		if (!Number.isFinite(cfg.heartbeatSec) || cfg.heartbeatSec <= 0) throw new Error("VoiceBroker heartbeat must be positive");
		this.active = cfg.endpoints.map(() => 0);
		this.now = cfg.now ?? Date.now;
	}

	private ttlMs(): number {
		return this.cfg.heartbeatSec * 1000 * 3;
	}

	/** Reclaim abandoned leases by missed heartbeats, independently of generation deadlines. */
	sweep(): void {
		const t = this.now();
		const leaseCutoff = t - this.ttlMs();
		for (const [id, l] of this.leases) {
			const expired = l.lastBeat < leaseCutoff;
			if (expired) {
				this.leases.delete(id);
				this.active[l.endpointIdx]!--;
			}
		}
		this.overflow = 0;
	}

	/** Pick the least-loaded endpoint with a free slot and assign a lease, or queue
	 *  (202) when every endpoint is full. */
	lease(): LeaseResult {
		this.sweep();
		let best = -1;
		for (let i = 0; i < this.cfg.endpoints.length; i++) {
			if (this.active[i]! >= this.cfg.capacity) continue;
			if (best === -1 || this.active[i]! < this.active[best]!) best = i;
		}
		if (best === -1) {
			this.overflow++;
			return { granted: false, queued: true, position: this.overflow };
		}
		const leaseId = randomBytes(16).toString("hex");
		this.active[best]!++;
		const t = this.now();
		this.leases.set(leaseId, { endpointIdx: best, lastBeat: t });
		const inst = this.cfg.endpoints[best]!;
		return {
			granted: true,
			leaseId,
			ttsUrl: inst.ttsUrl,
			heartbeatSec: this.cfg.heartbeatSec,
		};
	}

	/** Refresh a lease's keepalive. Returns false for an unknown/expired lease (the
	 *  caller should re-lease). */
	heartbeat(leaseId: string): boolean {
		this.sweep();
		const l = this.leases.get(leaseId);
		if (!l) return false;
		l.lastBeat = this.now();
		return true;
	}

	/** Drop a lease and free its slot. Tolerant of unknown ids (double release, or a
	 *  release racing a TTL reclaim). */
	release(leaseId: string): void {
		const l = this.leases.get(leaseId);
		if (!l) return;
		this.leases.delete(leaseId);
		this.active[l.endpointIdx]!--;
	}

	/** Snapshot for diagnostics/tests. */
	stats(): { capacity: number; endpoints: { active: number }[]; totalLeases: number } {
		return {
			capacity: this.cfg.capacity,
			endpoints: this.active.map((a) => ({ active: a })),
			totalLeases: this.leases.size,
		};
	}
}

import type { Context, Hono, MiddlewareHandler } from "hono";

/** Extract a leaseId from a request, tolerating navigator.sendBeacon — whose body
 *  may arrive as text/plain or a Blob, not JSON. Checks the query param first, then
 *  a JSON body, then a bare text body. */
async function leaseIdFrom(c: Context): Promise<string> {
	const q = c.req.query("leaseId");
	if (q) return q.trim();
	const raw = await c.req.text().catch(() => "");
	if (!raw) return "";
	try {
		const o = JSON.parse(raw) as { leaseId?: unknown };
		if (typeof o.leaseId === "string") return o.leaseId.trim();
	} catch {
		// not JSON — a sendBeacon text/plain body may be the bare leaseId
	}
	return raw.trim();
}

export function registerVoiceRoutes(
	app: Hono,
	broker: VoiceBroker,
	// Lease minting is open to any visitor and the broker's capacity is small,
	// so the gateway's per-client window is what keeps one client from holding
	// every slot. Omitted only by tests exercising the broker itself.
	limit: MiddlewareHandler = async (_c, next) => next(),
): void {
	app.post("/voice/lease", limit, (c) => {
		const r = broker.lease();
		if (r.granted) {
			return c.json({
				leaseId: r.leaseId,
				ttsUrl: r.ttsUrl,
				heartbeatSec: r.heartbeatSec,
			});
		}
		return c.json({ queued: true, position: r.position }, 202);
	});

	app.post("/voice/heartbeat", limit, async (c) => {
		const leaseId = await leaseIdFrom(c);
		if (!leaseId) return c.json({ error: "missing leaseId" }, 400);
		if (!broker.heartbeat(leaseId)) {
			return c.json({ error: "unknown or expired lease" }, 404);
		}
		return c.json({ ok: true });
	});

	app.post("/voice/release", limit, async (c) => {
		const leaseId = await leaseIdFrom(c);
		if (leaseId) broker.release(leaseId);
		// Always 200 — release is best-effort cleanup (often a fire-and-forget beacon
		// on unload), and the TTL sweeper is the backstop for anything missed.
		return c.json({ ok: true });
	});
}
