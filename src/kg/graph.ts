// The term-store engine — load + indexes + term-match, plus the mutable store
// API (getOrCreate / aliases / rename / merge / remove) that the personal
// memory is built on. A keyword router over evergreen descriptions: no edges,
// no graph traversal.

import { depluralize, normalizeForMatch, stripPluralS, stemText, stemWord, tokenize } from "./stem";
import { DESCRIPTION_WORD_CAP } from "./config";
import { PhraseIndex } from "./phrase-index";
import { validVector, type GraphAsset, type TermMatch, type Thought } from "./types";

interface TermEntry {
	node_id: string;
	no_stem: boolean;
	case_sensitive?: boolean;
	surface: string;
	via: "label" | "alias";
}

const isAcronym = (surface: string): boolean => /^[A-Z]{2,}$/.test(surface);
const mechanicalKey = (surface: string): string => surface.trim().toLowerCase().replace(/[-\s]+/g, " ");
const normalizeWords = (text: string, normalize: (word: string) => string): string =>
	text.replace(/[\p{L}\p{N}_]+/gu, normalize);

function nowIso(): string {
	return new Date().toISOString();
}

/** Thrown at any write site when a term description exceeds the word cap. */
export class DescriptionTooLongError extends Error {
	constructor(
		public readonly label: string,
		public readonly wordCount: number,
	) {
		super(`Description for '${label}' is ${wordCount} words (cap ${DESCRIPTION_WORD_CAP})`);
		this.name = "DescriptionTooLongError";
	}
}

export class Graph {
	thoughts: Map<string, Thought> = new Map();

	// lowercase label -> id
	labelIndex: Map<string, string> = new Map();
	// stemmed label -> set of ids
	stemIndex: Map<string, Set<string>> = new Map();

	// term-match indexes (built lazily)
	private termSingle: Map<string, TermEntry[]> = new Map();
	private termMulti: Array<[string, TermEntry]> = [];
	private exactPhrases = new PhraseIndex<number>([]);
	private stemmedPhrases = new PhraseIndex<number>([]);
	private termIndexValid = false;

	constructor(asset: GraphAsset) {
		this.load(asset);
	}

	// -- load() -----------------------------------------------------------
	private load(asset: GraphAsset): void {
		const record = (value: unknown): value is Record<string, unknown> =>
			value !== null && typeof value === "object" && !Array.isArray(value);
		if (!record(asset) || !record(asset.meta) || !record(asset.thoughts) ||
				asset.meta.version !== 2 || !Number.isInteger(asset.meta.node_count) ||
				asset.meta.node_count !== Object.keys(asset.thoughts).length || typeof asset.meta.last_modified !== "string") {
			throw new Error("Invalid memory asset metadata or term collection");
		}
		const labels = new Set<string>();
		const validated: Thought[] = [];
		for (const [id, raw] of Object.entries(asset.thoughts)) {
			if (!record(raw) || raw.id !== id || !id || typeof raw.label !== "string" || !raw.label.trim() ||
					!(raw.description === null || typeof raw.description === "string") ||
					!(raw.entity_type === null || typeof raw.entity_type === "string") ||
					!Array.isArray(raw.aliases) || !raw.aliases.every(a => typeof a === "string" && a.trim()) ||
					!Number.isSafeInteger(raw.hit_count) || raw.hit_count < 0 ||
					(raw.hit_count_tool !== undefined && (!Number.isSafeInteger(raw.hit_count_tool) || raw.hit_count_tool < 0 || raw.hit_count_tool > raw.hit_count)) ||
					!(raw.metadata === null || record(raw.metadata)) ||
					(raw.metadata !== null && raw.metadata.no_stem !== undefined && typeof raw.metadata.no_stem !== "boolean") ||
					[raw.created_at, raw.updated_at, raw.last_fired].some(v => v !== undefined && typeof v !== "string")) {
				throw new Error(`Invalid memory term '${id}'`);
			}
			const key = raw.label.toLowerCase();
			if (labels.has(key)) throw new Error(`Duplicate memory label '${raw.label}'`);
			labels.add(key);
			this.validateDescriptionLength(raw.description, raw.label);
			const t = structuredClone(raw) as unknown as Thought;
			// Legacy or malformed vectors cannot establish their encoder space. The
			// description remains intact and is available to string-only dedup.
			if (!validVector(t.embedding) || typeof t.embedding_encoder !== "string" || !t.embedding_encoder.trim()) {
				t.embedding = null;
				t.embedding_encoder = null;
			}
			validated.push(t);
		}
		for (const t of validated) {
			this.thoughts.set(t.id, t);
			this.labelIndex.set(t.label.toLowerCase(), t.id);
			this.indexStem(t);
		}
	}

	private indexStem(t: Thought): void {
		const stemmed = stemWord(t.label);
		let set = this.stemIndex.get(stemmed);
		if (!set) {
			set = new Set();
			this.stemIndex.set(stemmed, set);
		}
		set.add(t.id);
	}

	private unindex(t: Thought): void {
		this.labelIndex.delete(t.label.toLowerCase());
		const stemmed = stemWord(t.label);
		const set = this.stemIndex.get(stemmed);
		if (set) {
			set.delete(t.id);
			if (!set.size) this.stemIndex.delete(stemmed);
		}
	}

	// -- mutation: CRUD ---------------------------------------------------

	/** Empty mutable store — the personal memory starts here. */
	static empty(): Graph {
		return new Graph({
			meta: { version: 2, node_count: 0, last_modified: nowIso() },
			thoughts: {},
		});
	}

	get(label: string): Thought | null {
		const id = this.labelIndex.get(label.toLowerCase());
		return id ? (this.thoughts.get(id) ?? null) : null;
	}

	private touch(t: Thought): void {
		t.updated_at = nowIso();
	}

	fire(t: Thought, source: "message" | "tool" = "message"): void {
		t.hit_count = (t.hit_count ?? 0) + 1;
		if (source === "tool") t.hit_count_tool = (t.hit_count_tool ?? 0) + 1;
		t.last_fired = nowIso();
	}

	private validateDescriptionLength(description: string | null | undefined, label: string): void {
		if (description == null) return;
		const words = description.trim().split(/\s+/).filter(Boolean).length;
		if (words > DESCRIPTION_WORD_CAP) throw new DescriptionTooLongError(label, words);
	}

	private invalidateTermIndex(): void {
		this.termIndexValid = false;
		this.termSingle = new Map();
		this.termMulti = [];
		this.exactPhrases = new PhraseIndex<number>([]);
		this.stemmedPhrases = new PhraseIndex<number>([]);
	}

	private aliasOwner(surface: string, exceptId?: string): Thought | undefined {
		return [...this.thoughts.values()].find(t => t.id !== exceptId &&
			t.aliases.some(alias => mechanicalKey(alias) === mechanicalKey(surface)));
	}

	// getOrCreate — label-upsert; on collision only description / entity_type
	// are updated. 100-word cap enforced before write. A description change
	// nulls the stored embedding (stale until re-embedded on the write path).
	getOrCreate(label: string, description?: string | null, entityType?: string | null): Thought {
		if (!label.trim()) throw new Error("Term label must not be empty");
		const existing = this.get(label);
		if (existing) {
			if (description != null && existing.description !== description) {
				if (!description.trim() && existing.aliases.length) throw new Error("Cannot clear a description while aliases route to it");
				this.validateDescriptionLength(description, label);
				existing.description = description;
				existing.embedding = null;
				existing.embedding_encoder = null;
				this.touch(existing);
				this.invalidateTermIndex(); // null→value changes term-index membership
			}
			if (entityType != null && existing.entity_type !== entityType) {
				existing.entity_type = entityType;
				this.touch(existing);
			}
			return existing;
		}
		if (this.aliasOwner(label)) throw new Error(`Label '${label}' is already an alias of another term`);
		this.validateDescriptionLength(description, label);
		const now = nowIso();
		const t: Thought = {
			id: crypto.randomUUID(),
			label,
			last_fired: now,
			description: description ?? null,
			entity_type: entityType ?? null,
			aliases: [],
			embedding: null,
			hit_count: 0,
			created_at: now,
			updated_at: now,
			metadata: null,
		};
		this.thoughts.set(t.id, t);
		this.labelIndex.set(label.toLowerCase(), t.id);
		this.indexStem(t);
		this.invalidateTermIndex();
		return t;
	}

	/** Add a distinct surface form to a described term, preserving acronym case.
	 * Undescribed targets and mechanical/colliding routes are refused. */
	addAlias(label: string, alias: string): boolean {
		const t = this.get(label);
		if (!t || !t.description?.trim()) return false;
		const a = alias.trim();
		if (!a || mechanicalKey(a) === mechanicalKey(t.label)) return false;
		if ([...this.thoughts.values()].some(other => mechanicalKey(other.label) === mechanicalKey(a))) return false;
		for (const other of this.thoughts.values()) {
			if (other.aliases.some(value => mechanicalKey(value) === mechanicalKey(a))) return false;
		}
		t.aliases.push(a);
		this.touch(t);
		this.invalidateTermIndex();
		return true;
	}

	removeAlias(label: string, alias: string): boolean {
		const t = this.get(label);
		if (!t) return false;
		const a = alias.trim().toLowerCase();
		const idx = t.aliases.findIndex(value => value.toLowerCase() === a);
		if (idx < 0) return false;
		t.aliases.splice(idx, 1);
		this.touch(t);
		this.invalidateTermIndex();
		return true;
	}

	/** Relabel a term in place (description, aliases, hit count preserved). */
	rename(oldLabel: string, newLabel: string): boolean {
		const t = this.get(oldLabel);
		if (!t) return false;
		if (!newLabel.trim() || this.get(newLabel) || this.aliasOwner(newLabel, t.id)) return false; // target route taken
		this.unindex(t);
		t.label = newLabel;
		t.aliases = t.aliases.filter(alias => mechanicalKey(alias) !== mechanicalKey(newLabel));
		t.embedding = null;
		t.embedding_encoder = null;
		this.touch(t);
		this.labelIndex.set(newLabel.toLowerCase(), t.id);
		this.indexStem(t);
		this.invalidateTermIndex();
		return true;
	}

	/** Merge the loser term into the survivor: the loser's label + aliases become
	 * survivor aliases, hit counts sum, the loser is deleted. The survivor's
	 * description wins; a merge cannot discard the only nonempty description. */
	merge(loserLabel: string, survivorLabel: string): boolean {
		const loser = this.get(loserLabel);
		const survivor = this.get(survivorLabel);
		if (!loser || !survivor || loser.id === survivor.id) return false;
		if (loser.description?.trim() && !survivor.description?.trim()) return false;
		this.unindex(loser);
		this.thoughts.delete(loser.id);
		for (const alias of [loser.label, ...loser.aliases]) {
			// Bare stubs carry inert aliases until a description makes them routable.
			if (survivor.description?.trim()) this.addAlias(survivor.label, alias);
			else if (
				mechanicalKey(alias) !== mechanicalKey(survivor.label) &&
				![...this.thoughts.values()].some(other =>
					mechanicalKey(other.label) === mechanicalKey(alias) ||
					other.aliases.some(a => mechanicalKey(a) === mechanicalKey(alias)))
			) survivor.aliases.push(alias);
		}
		survivor.hit_count = (survivor.hit_count ?? 0) + (loser.hit_count ?? 0);
		if (survivor.hit_count_tool !== undefined || loser.hit_count_tool !== undefined) survivor.hit_count_tool = (survivor.hit_count_tool ?? 0) + (loser.hit_count_tool ?? 0);
		this.touch(survivor);
		this.invalidateTermIndex();
		return true;
	}

	remove(label: string): boolean {
		const t = this.get(label);
		if (!t) return false;
		this.unindex(t);
		this.thoughts.delete(t.id);
		this.invalidateTermIndex();
		return true;
	}

	setNoStem(label: string, noStem: boolean): boolean {
		const t = this.get(label);
		if (!t) return false;
		t.metadata = { ...(t.metadata ?? {}), no_stem: noStem };
		this.touch(t);
		this.invalidateTermIndex();
		return true;
	}

	// Serialize to the GraphAsset shape for IndexedDB persistence.
	serialize(): GraphAsset {
		const thoughts: Record<string, Thought> = Object.create(null);
		let nodeCount = 0;
		for (const [id, t] of this.thoughts) {
			thoughts[id] = t;
			nodeCount++;
		}
		return {
			meta: { version: 2, node_count: nodeCount, last_modified: nowIso() },
			thoughts,
		};
	}

	// -- searchText() -----------------------------------------------------
	// A LITERAL substring search for the memory_search tool — distinct from
	// termMatch (which is term-index-driven, descriptions-only, and runs the
	// inverse direction). Lowercased `.includes` over each term's label +
	// description + aliases. Ranked by hit_count desc. Default limit 50,
	// hard cap 100.
	searchText(query: string, limit = 50): { label: string; description: string; hit_count: number }[] {
		const q = query.trim().toLowerCase();
		if (!q) return [];
		const cap = Number.isFinite(limit) ? Math.min(Math.max(limit, 1), 100) : 50;

		const results: { label: string; description: string; hit_count: number }[] = [];
		for (const t of this.thoughts.values()) {
			const hit =
				t.label.toLowerCase().includes(q) ||
				(t.description ?? "").toLowerCase().includes(q) ||
				t.aliases.some((a) => a.toLowerCase().includes(q));
			if (hit) {
				results.push({ label: t.label, description: t.description ?? "", hit_count: t.hit_count });
			}
		}
		results.sort((a, b) => b.hit_count - a.hit_count);
		return results.slice(0, cap);
	}

	// -- buildTermIndex() -------------------------------------------------
	private buildTermIndex(): void {
		// Multi-valued so terms that prepare to the same key (e.g. two stems
		// colliding, or a later label reusing an earlier term's alias key) coexist
		// instead of last-writer-wins silently shadowing one of them.
		const termIndex = new Map<string, TermEntry[]>();
		const record = (key: string, entry: TermEntry): void => {
			let list = termIndex.get(key);
			if (!list) {
				list = [];
				termIndex.set(key, list);
			}
			if (!list.some((e) => e.node_id === entry.node_id)) list.push(entry);
		};

		const push = (key: string, entry: TermEntry): void => {
			record(key, entry);
			if (!entry.case_sensitive && entry.no_stem) {
				record(normalizeWords(key, depluralize), entry);
				record(normalizeWords(key, stripPluralS), entry);
			}
		};

		for (const t of this.thoughts.values()) {
			if (!t.description?.trim()) continue;

			const noStem = t.metadata?.no_stem ?? true; // default: exact match
			const caseSensitive = isAcronym(t.label);
			const preparedKey = caseSensitive ? t.label : noStem ? normalizeForMatch(t.label) : stemText(t.label);
			push(preparedKey, { node_id: t.id, no_stem: noStem || caseSensitive, case_sensitive: caseSensitive, surface: t.label, via: "label" });

			// Auto-alias: labels carrying internal punctuation the tokenizer splits on
			// (hyphens, apostrophes, …) get a space-separated variant, so a form typed
			// or spoken with the punctuation still routes. tokenize() yields the same
			// space-joined shape the query side rejoins to.
			const labelJoined = tokenize(t.label).join(" ");
			if (labelJoined.includes(" ") && labelJoined !== preparedKey) {
				push(noStem ? labelJoined : stemText(labelJoined), { node_id: t.id, no_stem: noStem, surface: t.label, via: "label" });
			}

			// Explicit aliases (spoken variants, abbreviations, persistent
			// mistranscriptions) — always exact-matched. Punctuated aliases get the
			// same space-separated variant as labels (a hyphenated/apostrophe'd key
			// never matches the tokenizer's split words otherwise).
			for (const alias of t.aliases) {
				const caseSensitive = isAcronym(alias);
				const preparedAlias = caseSensitive ? alias : normalizeForMatch(alias);
				push(preparedAlias, { node_id: t.id, no_stem: true, case_sensitive: caseSensitive, surface: alias, via: "alias" });
				const aliasJoined = tokenize(alias).join(" ");
				if (aliasJoined.includes(" ") && aliasJoined !== preparedAlias) {
					push(aliasJoined, { node_id: t.id, no_stem: true, surface: alias, via: "alias" });
				}
			}
		}

		// Only tokenizer-compatible keys use lookup; punctuation requires literal matching.
		this.termSingle = new Map();
		this.termMulti = [];
		for (const [key, entries] of termIndex) {
			if (!/^[\p{L}\p{N}_]+$/u.test(key)) {
				for (const data of entries) this.termMulti.push([key, data]);
			} else {
				this.termSingle.set(key, entries);
			}
		}
		this.exactPhrases = new PhraseIndex(this.termMulti.flatMap(([key, data], index) => data.no_stem ? [[key, index] as const] : []));
		this.stemmedPhrases = new PhraseIndex(this.termMulti.flatMap(([key, data], index) => !data.no_stem ? [[key, index] as const] : []));
		this.termIndexValid = true;
	}

	private ensureTermIndex(): void {
		if (!this.termIndexValid) this.buildTermIndex();
	}

	// -- termMatch() ------------------------------------------------------
	termMatch(text: string): TermMatch[] {
		this.ensureTermIndex();
		const lowercased = normalizeForMatch(text);
		const matchedIds = new Set<string>();
		const matchedRoutes = new Map<string, TermEntry>();
		const noteMatch = (entry: TermEntry): void => {
			matchedIds.add(entry.node_id);
			// One bounded route per term; a canonical label route outranks aliases.
			if (!matchedRoutes.has(entry.node_id) || entry.via === "label") {
				matchedRoutes.set(entry.node_id, entry);
			}
		};

		const tokensLower = new Set(tokenize(lowercased));
		// Depluralized variants — always applied to exact (no_stem) matching so a
		// spoken S-plural ("graphs") still finds the singular label ("graph").
		const tokensSingular = new Set([...tokensLower].flatMap((t) => [depluralize(t), stripPluralS(t)]));

		// Fast path: single-word exact (no_stem) matches.
		for (const token of new Set([...tokensLower, ...tokensSingular])) {
			const entries = this.termSingle.get(token);
			if (entries) {
				for (const data of entries) {
					if (data.no_stem && !data.case_sensitive) noteMatch(data);
				}
			}
		}
		for (const token of text.match(/[\p{L}\p{N}_]+/gu) ?? []) {
			for (const entry of this.termSingle.get(token) ?? []) {
				if (entry.case_sensitive) noteMatch(entry);
			}
		}

		// Single-word stemmed matches (opt-in only).
		const tokensStemmed = new Set([...tokensLower].map((t) => stemWord(t)));
		for (const stemmedToken of tokensStemmed) {
			const entries = this.termSingle.get(stemmedToken);
			if (entries) {
				for (const data of entries) {
					if (!data.no_stem) noteMatch(data);
				}
			}
		}

		// Phrase indexes scan each normalized query once, including tool output.
		// Tokens rejoined with single spaces (no depluralization) so a multi-word
		// exact key ("apis mellifera") matches input typed with the internal
		// punctuation ("apis-mellifera") — the tokenizer splits the punct, the
		// rejoin normalizes it to the stored space-joined form.
		const rejoinedText = tokenize(lowercased).join(" ");
		// Depluralized text so a multi-word exact key ("term store") still
		// matches an S-pluralized phrase ("term stores") in the input.
		const singularText = tokenize(lowercased).map((t) => depluralize(t)).join(" ");
		const simpleText = normalizeWords(lowercased, stripPluralS);
		const phraseHits = new Set<number>();
		for (const query of new Set([lowercased, rejoinedText, singularText, simpleText])) {
			for (const index of this.exactPhrases.match(query)) phraseHits.add(index);
		}
		if (!this.stemmedPhrases.isEmpty) for (const index of this.stemmedPhrases.match(stemText(lowercased))) phraseHits.add(index);
		// Preserve original route precedence when several indexed surfaces match.
		for (const index of [...phraseHits].sort((a, b) => a - b)) noteMatch(this.termMulti[index][1]);

		// Build results.
		const results: TermMatch[] = [];
		for (const nodeId of matchedIds) {
			const node = this.thoughts.get(nodeId);
			if (!node || !node.description) continue;
			results.push({
				matched_surface: matchedRoutes.get(nodeId)!.surface,
				matched_via: matchedRoutes.get(nodeId)!.via,
				label: node.label,
				description: node.description,
				hit_count: node.hit_count,
			});
		}
		results.sort((a, b) => (a.label < b.label ? -1 : a.label > b.label ? 1 : 0));
		return results;
	}
}
