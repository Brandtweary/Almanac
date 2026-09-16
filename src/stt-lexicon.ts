// The speech-adaptation half of the lexicon: the mistranscription log and the
// auto-replace rules, persisted in IndexedDB and exported alongside the term
// glossary. Auto-replace rules rewrite Whisper transcripts client-side BEFORE
// they reach the display or the model — the same one-way mechanism as the
// harness's config.toml replacements, which is exactly why the audit agent's
// rules for creating them are conservative.

import { escapeRegExp } from "./regex-utils";

export interface VoiceEvidence { utteranceId: string; rawText: string; correctedText: string; }

export interface MistranscriptionEntry {
	spoken: string; // what the user actually said
	transcribed: string; // what Whisper wrote
	kind: "phonetic" | "semantic" | "persistent_near_miss";
	notes?: string;
	utteranceId?: string;
	rawText?: string;
	status?: "accepted" | "rejected";
	ts: string;
}

export interface AutoReplaceRule {
	from: string; // the mistranscribed phrase (matched case-insensitively, whole-phrase)
	to: string; // the correct phrase
	ts: string;
}

export interface SttLexicon {
	mistranscriptions: MistranscriptionEntry[];
	autoReplace: AutoReplaceRule[];
}

export function emptySttLexicon(): SttLexicon {
	return { mistranscriptions: [], autoReplace: [] };
}

/** Count distinct, attributable utterances. Legacy unpinned rows remain inspectable
 * but cannot establish independent recurrence. Rejected pairs never count. */
export function mistranscriptionCount(lex: SttLexicon, spoken: string, transcribed: string): number {
	const s = spoken.trim().toLowerCase();
	const t = transcribed.trim().toLowerCase();
	return new Set(lex.mistranscriptions.filter(
		(m) => m.status !== "rejected" && m.utteranceId && m.spoken.trim().toLowerCase() === s && m.transcribed.trim().toLowerCase() === t,
	).map(m => m.utteranceId)).size;
}

/** Rewrite voice text with literal replacements and Unicode token boundaries.
 * Typed input never passes through this function. */
export function applyAutoReplace(text: string, rules: AutoReplaceRule[]): string {
	let out = text;
	for (const r of rules) {
		if (!r.from.trim()) continue;
		const pattern = phrasePattern(r.from);
		out = out.replace(pattern, () => r.to);
	}
	return out;
}

/** Unicode token boundaries also protect punctuation-bearing phrases from embedded matches. */
export function phrasePattern(value: string): RegExp {
	return new RegExp(`(?<![\\p{L}\\p{N}\\p{M}_])${escapeRegExp(value)}(?![\\p{L}\\p{N}\\p{M}_])`, "giu");
}

let dictionary: Promise<Set<string>> | undefined;
async function englishWords(): Promise<Set<string>> {
	return dictionary ??= import("../node_modules/word-list/words.txt?raw").then(({default: words}) => new Set(words.split(/\r?\n/)));
}

export async function validateAutoReplace(from: string, to: string): Promise<void> {
	if (!from.trim() || !to.trim()) throw new Error("Both phrases must be nonempty.");
	if (from !== from.trim() || to !== to.trim()) throw new Error("Trim outer whitespace and retry.");
	if (from.toLowerCase() === to.toLowerCase()) throw new Error("The pair must change speech, not just capitalization.");
	if (Math.max(from.split(/\s+/).length, to.split(/\s+/).length) > 4) throw new Error("Pair exceeds four words. Remove correctly transcribed padding; keep only context that prevents a real collision, or log manually.");
	if (/^(the|a|an)\s/i.test(from) || /^(the|a|an)\s/i.test(to)) throw new Error("Remove leading articles from the rule; do not inject an article into speech.");
	if (!/\s/u.test(from)) {
		const words = await englishWords();
		const parts = from.toLowerCase().replace(/^[^\p{L}]+|[^\p{L}]+$/gu, "").split(/[-’']/u);
		const clitics = new Set(["t", "s", "re", "ve", "ll", "d", "m", "all", "em"]);
		if (parts.every(part => words.has(part) || clitics.has(part))) throw new Error("A real English word cannot be auto-replaced. Keep this as a manual log; use a bound phrase only when the raw utterance supports it.");
	}
}
