// The shapes for the serialized memory asset and the retrieval outputs.

export interface Thought {
	id: string;
	label: string;
	last_fired?: string;
	description: string | null;
	entity_type: string | null;
	// Alternative surface forms that route to this term (spoken variants,
	// abbreviations, persistent mistranscriptions). ASCII uppercase acronyms
	// retain case; other surfaces share the label normalization.
	aliases: string[];
	// Encoder-tagged embedding of label plus description. Legacy untagged
	// vectors are discarded on load; the description remains available.
	embedding?: number[] | null;
	embedding_encoder?: string | null;
	hit_count: number;
	created_at?: string;
	updated_at?: string;
	metadata: { no_stem?: boolean } | null;
}

// The serialized memory asset persisted to IndexedDB (the term half of the
// exportable lexicon).
export interface GraphAsset {
	meta: {
		version: number;
		node_count: number;
		last_modified: string;
	};
	thoughts: Record<string, Thought>;
}

// term_match result (left gutter).
export interface TermMatch {
	// Original indexed surface, not a claim about the literal transcript span.
	matched_surface: string;
	matched_via: "label" | "alias";
	label: string;
	description: string;
	hit_count: number;
}

/** A vector is comparable only within an explicitly identified encoder space. */
export interface Embedding {
	vector: number[];
	encoder: string;
}

export function validVector(value: unknown): value is number[] {
	return Array.isArray(value) && value.length > 0 && value.every(n => typeof n === "number" && Number.isFinite(n)) && value.some(n => n !== 0);
}
