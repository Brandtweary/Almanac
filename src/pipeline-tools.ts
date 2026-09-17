// The pipeline agents' tool set — full mutation authority over the term memory
// plus the speech-adaptation stores and the human-review flags store. Shared by
// the audit agent and the memory agent (identical tools keep the request
// prefix cache-shared; the prompts govern who does what). Every execute records
// a one-line action via `record` — that stream IS the action buffer and the
// activity feed, so no tool result needs self-reporting ceremony.

import type { AgentTool } from "@earendil-works/pi-agent-core";
import { type Static, type TSchema, Type } from "typebox";
import { DescriptionTooLongError, type Graph } from "./kg/graph.js";
import type { EmbedFn } from "./kg/embed.js";
import { findSimilarTerms } from "./kg/similarity.js";
import {
	type SttLexicon,
	mistranscriptionCount, validateAutoReplace, phrasePattern, type VoiceEvidence,
} from "./stt-lexicon.js";
import { recordMerge, assertMaintenanceMergeAllowed, type MaintenanceState } from "./glossary-maintenance.js";
import { speechCandidates } from "./stt-candidates.js";
import type { PhonemizeFn } from "./stt-phonemize.js";

// Rolling cap on the mistranscription log: it appends per voice turn and rides the
// lexicon export blob, so an uncapped log would bloat both IndexedDB and every export.
const MISTRANSCRIPTION_LOG_MAX = 500;

export interface ReviewFlag {
	kind: string;
	label?: string;
	description: string;
	ts: string;
}

export interface PipelineToolDeps {
	getGraph: () => Graph;
	assertActive?: () => void;
	voiceEvidence?: VoiceEvidence;
	phonemize?: PhonemizeFn;
	signal?: AbortSignal;
	embed: EmbedFn;
	getSttLexicon: () => SttLexicon;
	addFlag: (flag: ReviewFlag) => void;
	record: (line: string) => void;
	/** Stable identities retain concurrent retrieval counters through draft merges. */
	maintenance?: MaintenanceState;
	onMerge?: (loserId: string, survivorId: string) => void;
}

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }], details: {} });

// Keep each tool literal contextually typed against ITS schema (so `execute`
// params are Static<S>), then erase to AgentTool<any> for the mixed array.
const tool = <S extends TSchema>(t: AgentTool<S>): AgentTool<any> => t as AgentTool<any>;

export function createPipelineTools(deps: PipelineToolDeps): AgentTool<any>[] {
	const { getGraph, embed, getSttLexicon, addFlag, record } = deps;
	const aliasKey = (value: string) => value.trim().toLowerCase().replace(/[-\s]+/g, " ");
	const flagExistingSttAliases = (transcribed: string, spoken: string): string => {
		const terms = Object.values(getGraph().serialize().thoughts).filter(term =>
			aliasKey(term.label) === aliasKey(spoken) && term.aliases.some(alias => aliasKey(alias) === aliasKey(transcribed)));
		if (!terms.length) return "";
		const description = `Rejected STT pair still routes through an alias: ${transcribed} → ${terms.map(t => t.label).join(", ")}. Alias origin is unavailable; inspect_term and remove_alias only if it came from this mistaken pairing, preserving deliberate aliases.`;
		addFlag({kind: "stt-alias-review", description, ts: new Date().toISOString()});
		return ` ${description}`;
	};

	// Embed a term's description and store the vector. Awaited inside the write
	// tools so the vector lands before the tick's save; fail-soft (null keeps
	// similar_terms string-only for this term).
	const embedTerm = async (label: string): Promise<void> => {
		const graph = getGraph();
		const t = graph.get(label);
		if (!t || !t.description) return;
		const input = `${t.label}: ${t.description}`;
		const result = await embed(input);
		deps.assertActive?.();
		if (getGraph() !== graph || graph.get(label) !== t || `${t.label}: ${t.description}` !== input) return;
		t.embedding = result?.vector ?? null;
		t.embedding_encoder = result?.encoder ?? null;
	};

	const addTermSchema = Type.Object({
		label: Type.String({
			description: "Short, hyphenated, lowercase term name (e.g. 'vector-database').",
		}),
		description: Type.String({
			description: "Evergreen definition (hard 100-word cap; aim 50-80 words).",
		}),
		type: Type.Optional(
			Type.String({
				description: "Most specific of: person|project|tool|concept|organism|place|other.",
			}),
		),
	});

	const updateDescriptionSchema = Type.Object({
		label: Type.String(),
		description: Type.String({
			description: "The full replacement description (hard 100-word cap).",
		}),
	});

	const aliasSchema = Type.Object({
		term: Type.String({ description: "The canonical term label." }),
		alias: Type.String({ description: "The alternative surface form to route to it." }),
	});

	const renameSchema = Type.Object({
		from: Type.String(),
		to: Type.String(),
	});

	const mergeSchema = Type.Object({
		loser: Type.String({ description: "The term to fold in (its label becomes an alias)." }),
		survivor: Type.String({ description: "The term that remains." }),
	});

	const labelSchema = Type.Object({ label: Type.String() });

	const noStemSchema = Type.Object({
		label: Type.String(),
		no_stem: Type.Boolean({
			description: "true disables Porter stemming; plural and punctuation normalization remain. false enables Porter stemming.",
		}),
	});

	const similarSchema = Type.Object({
		label: Type.String({ description: "The candidate label to check." }),
		description: Type.Optional(
			Type.String({ description: "Candidate description — enables semantic comparison." }),
		),
	});

	const mistranscriptionSchema = Type.Object({
		spoken: Type.String({ description: "What the user actually said." }),
		transcribed: Type.String({ description: "What the transcriber wrote." }),
		kind: Type.Union([
			Type.Literal("phonetic"),
			Type.Literal("semantic"),
			Type.Literal("persistent_near_miss"),
		]),
		notes: Type.Optional(Type.String()),
	});

	const autoReplaceSchema = Type.Object({
		from: Type.String({ description: "The mistranscribed phrase (whole-phrase matched)." }),
		to: Type.String({ description: "The correct phrase." }),
		exact_case: Type.Optional(Type.Boolean({ description: "Match only this exact raw capitalization; required for capitalization-only repairs." })),
	});

	const flagSchema = Type.Object({
		kind: Type.String({
			description: "Flag category, e.g. 'lexicon-colonization', 'llm-misspelling', 'needs-surgery'.",
		}),
		label: Type.Optional(Type.String({ description: "The term label concerned, if any." })),
		description: Type.String({ description: "One-line description for human review." }),
	});

	const tools = [
		tool({
			name: "add_term",
			label: "Add term",
			description:
				"Mint a new term in the memory (or update the description/type of an existing label — " +
				"this is an upsert). Check similar_terms first when minting.",
			parameters: addTermSchema,
			execute: async (_id, p: Static<typeof addTermSchema>) => {
				const label = p.label.trim();
				if (!label) throw new Error("empty label");
				const existed = getGraph().get(label) !== null;
				try {
					getGraph().getOrCreate(label, p.description, p.type ?? null);
				} catch (e) {
					if (e instanceof DescriptionTooLongError) {
						throw new Error(
							`description rejected: ${e.wordCount} words (hard cap 100). Shorten it and retry.`,
						);
					}
					throw e;
				}
				record(existed ? `updated ${label}` : `minted ${label}`);
				await embedTerm(label);
				return text(existed ? `Updated existing term '${label}'.` : `Minted new term '${label}'.`);
			},
		}),
		tool({
			name: "update_description",
			label: "Update description",
			description:
				"Replace an existing term's description. Augment, never regress: fold new information " +
				"and the speaker's current takes into what's already there.",
			parameters: updateDescriptionSchema,
			execute: async (_id, p: Static<typeof updateDescriptionSchema>) => {
				if (!getGraph().get(p.label)) throw new Error(`no term '${p.label}'`);
				try {
					getGraph().getOrCreate(p.label, p.description);
				} catch (e) {
					if (e instanceof DescriptionTooLongError) {
						throw new Error(
							`description rejected: ${e.wordCount} words (hard cap 100). Shorten it and retry.`,
						);
					}
					throw e;
				}
				record(`updated ${p.label}`);
				await embedTerm(p.label);
				return text(`Description of '${p.label}' updated.`);
			},
		}),
		tool({
			name: "add_alias",
			label: "Add alias",
			description:
				"Add an alternative surface form (abbreviation, spoken variant, persistent " +
				"mistranscription) that routes to an existing term.",
			parameters: aliasSchema,
			execute: async (_id, p: Static<typeof aliasSchema>) => {
				if (getSttLexicon().mistranscriptions.some(m => m.status === "rejected" && aliasKey(m.transcribed) === aliasKey(p.alias) && aliasKey(m.spoken) === aliasKey(p.term))) {
					throw new Error("This alias reproduces a rejected STT pairing. Inspect the rejection; flag for human review if a deliberate alias has an independent justification.");
				}
				if (!getGraph().addAlias(p.term, p.alias)) {
					throw new Error(
						`could not add alias '${p.alias}' to '${p.term}' (missing or undescribed target, blank or mechanically equivalent alias, or another term owns this label/alias); inspect_term and correct the conflicting input`,
					);
				}
				record(`aliased ${p.alias} → ${p.term}`);
				return text(`Alias '${p.alias}' → '${p.term}' added.`);
			},
		}),
		tool({
			name: "remove_alias",
			label: "Remove alias",
			description: "Remove an alias from a term (e.g. one causing false retrievals).",
			parameters: aliasSchema,
			execute: async (_id, p: Static<typeof aliasSchema>) => {
				if (!getGraph().removeAlias(p.term, p.alias)) {
					throw new Error(`no alias '${p.alias}' on '${p.term}'`);
				}
				record(`unaliased ${p.alias} from ${p.term}`);
				return text(`Alias '${p.alias}' removed from '${p.term}'.`);
			},
		}),
		tool({
			name: "rename_term",
			label: "Rename term",
			description:
				"Relabel a term in place (description, aliases, hit count preserved). For a label that " +
				"is genuinely wrong — e.g. a bare generic word that needs qualifying.",
			parameters: renameSchema,
			execute: async (_id, p: Static<typeof renameSchema>) => {
				if (!getGraph().rename(p.from, p.to)) {
					throw new Error(`rename failed (missing source, blank target, or target owned by an existing label/alias); inspect the terms before retrying`);
				}
				record(`renamed ${p.from} → ${p.to}`);
				await embedTerm(p.to);
				return text(`Renamed '${p.from}' → '${p.to}'.`);
			},
		}),
		tool({
			name: "merge_terms",
			label: "Merge terms",
			description:
				"Merge two terms that are genuinely the SAME concept: the loser's label and aliases " +
				"become aliases of the survivor, hit counts sum, the loser is deleted. Destructive — " +
				"see your merge policy before using.",
			parameters: mergeSchema,
			execute: async (_id, p: Static<typeof mergeSchema>) => {
				const graph = getGraph();
				const loser = graph.get(p.loser);
				const survivor = graph.get(p.survivor);
				const before = loser && survivor ? structuredClone([loser, survivor]) : null;
				if (before && deps.maintenance) assertMaintenanceMergeAllowed(deps.maintenance, before[0].id, before[1].id);
				if (!graph.merge(p.loser, p.survivor)) {
					throw new Error(`merge failed (missing term, same term twice, or described loser into undescribed survivor); inspect both terms, then describe the survivor or reverse the merge`);
				}
				if (before && deps.maintenance) recordMerge(deps.maintenance, before[0], before[1], "Pipeline merge_terms decision");
				deps.onMerge?.(loser!.id, survivor!.id);
				record(`merged ${p.loser} → ${p.survivor}`);
				return text(`Merged '${p.loser}' into '${p.survivor}'.`);
			},
		}),
		tool({
			name: "remove_term",
			label: "Remove term",
			description:
				"Delete a term outright (noise, a mistake, too vague to be useful). Destructive — " +
				"see your removal policy before using.",
			parameters: labelSchema,
			execute: async (_id, p: Static<typeof labelSchema>) => {
				if (!getGraph().remove(p.label)) throw new Error(`no term '${p.label}'`);
				record(`removed ${p.label}`);
				return text(`Removed '${p.label}'.`);
			},
		}),
		tool({
			name: "set_no_stem",
			label: "Set matching mode",
			description:
				"Set a term's Porter-stemming mode. no_stem=true (the default) disables Porter stemming, " +
				"but preserves plural and punctuation normalization; it does not separate singular and plural forms. " +
				"Use for a Porter-stemming collision only when stemming is currently enabled; otherwise inspect aliases or flag an unsupported repair.",
			parameters: noStemSchema,
			execute: async (_id, p: Static<typeof noStemSchema>) => {
				if (!getGraph().setNoStem(p.label, p.no_stem)) throw new Error(`no term '${p.label}'`);
				record(`set no_stem=${p.no_stem} on ${p.label}`);
				return text(`'${p.label}': Porter stemming ${p.no_stem ? "disabled; plural and punctuation normalization remain" : "enabled"}.`);
			},
		}),
		tool({
			name: "similar_terms",
			label: "Find similar terms",
			description:
				"Find existing terms similar to a candidate label — string similarity over " +
				"labels/aliases plus semantic similarity over descriptions. Call BEFORE minting a new " +
				"term; a hit that is the same concept means augment/alias instead of mint.",
			parameters: similarSchema,
			execute: async (_id, p: Static<typeof similarSchema>) => {
				const queryEmbedding = p.description ? await embed(`${p.label}: ${p.description}`) : null;
				const candidates = findSimilarTerms(getGraph(), p.label, queryEmbedding);
				if (!candidates.length) return text(`No similar terms to '${p.label}'.`);
				const lines = candidates.map((c) => {
					const scores = [
						`string ${c.stringScore.toFixed(2)}`,
						c.semanticScore !== null ? `semantic ${c.semanticScore.toFixed(2)}` : null,
					]
						.filter(Boolean)
						.join(", ");
					return `- **${c.term.label}** (${scores}): ${c.term.description ?? "(no description)"}`;
				});
				return text(`Similar to '${p.label}':\n${lines.join("\n")}`);
			},
		}),
		tool({
			name: "log_mistranscription",
			label: "Log mistranscription",
			description:
				"Log a speech-to-text error (what was said vs what was transcribed). The result " +
				"reports how many times this exact pair has been logged — the recurrence signal for " +
				"the persistent-miss alias escalation.",
			parameters: mistranscriptionSchema,
			execute: async (_id, p: Static<typeof mistranscriptionSchema>) => {
				const lex = getSttLexicon();
				const evidence = deps.voiceEvidence;
				if (!evidence || !p.transcribed.trim() || !phrasePattern(p.transcribed).test(evidence.rawText)) throw new Error("Log requires a matching span in this voice turn's raw transcript. Typed text and corrected output are not STT evidence.");
				if (lex.mistranscriptions.some(m => m.status === "rejected" && m.transcribed.toLowerCase() === p.transcribed.toLowerCase() && m.spoken.toLowerCase() === p.spoken.toLowerCase())) throw new Error("This pair was rejected. Do not reinterpret an intentional word or nickname as an STT error.");
				const prior = lex.mistranscriptions.find(m => m.utteranceId === evidence.utteranceId && m.transcribed.toLowerCase() === p.transcribed.toLowerCase());
				if (prior && prior.spoken.toLowerCase() !== p.spoken.toLowerCase()) throw new Error("This utterance already has a different proposed correction. Inspect it and use correct_mistranscription.");
				if (prior) return text(`Already logged this utterance; independent occurrences: ${mistranscriptionCount(lex, p.spoken, p.transcribed)}.`);
				lex.mistranscriptions.push({
					utteranceId: evidence.utteranceId, rawText: evidence.rawText, status: "accepted",
					spoken: p.spoken,
					transcribed: p.transcribed,
					kind: p.kind,
					notes: p.notes,
					ts: new Date().toISOString(),
				});
				if (lex.mistranscriptions.length > MISTRANSCRIPTION_LOG_MAX) {
					const rejected = lex.mistranscriptions.filter(m => m.status === "rejected");
					lex.mistranscriptions = [...rejected, ...lex.mistranscriptions.filter(m => m.status !== "rejected").slice(-MISTRANSCRIPTION_LOG_MAX)];
				}
				const count = mistranscriptionCount(lex, p.spoken, p.transcribed);
				record(`logged STT: ${p.transcribed} → ${p.spoken} (${p.kind}, seen ${count}×)`);
				return text(
					`Logged '${p.transcribed}' → '${p.spoken}' (${p.kind}). This pair has now been logged ${count} time(s).`,
				);
			},
		}),
		tool({
			name: "add_auto_replace_rule",
			label: "Add auto-replace rule",
			description:
				"Add a transcript auto-replace rule: every future voice transcript rewrites the 'from' " +
				"phrase to the 'to' phrase before anyone sees it. ONE-WAY CORRUPTION if wrong — see " +
				"your auto-vs-manual policy before using.",
			parameters: autoReplaceSchema,
			execute: async (_id, p: Static<typeof autoReplaceSchema>) => {
				await validateAutoReplace(p.from, p.to, p.exact_case);
				deps.assertActive?.();
				const lex = getSttLexicon();
				const matching = lex.mistranscriptions.filter(m => m.status !== "rejected" && m.utteranceId && m.rawText && phrasePattern(p.from, p.exact_case).test(m.rawText) && (p.exact_case ? m.transcribed === p.from : m.transcribed.toLowerCase() === p.from.toLowerCase()));
				if (!matching.some(m => m.spoken === p.to)) throw new Error("Log a supported raw-utterance correction first, including exact capitalization for exact_case. A dictionary lookup alone does not establish what was spoken.");
				if (matching.some(m => m.spoken.toLowerCase() !== p.to.toLowerCase())) throw new Error("This raw phrase has conflicting supported readings. Keep a manual correction or choose a genuinely bound phrase.");
				if (lex.mistranscriptions.some(m => m.status === "rejected" && m.transcribed.toLowerCase() === p.from.toLowerCase() && m.spoken.toLowerCase() === p.to.toLowerCase())) throw new Error("This pairing was rejected; inspect its evidence before reconsidering it.");
				if (lex.autoReplace.some((r) => r.from.toLowerCase() === p.from.toLowerCase())) {
					throw new Error(`a rule for '${p.from}' already exists`);
				}
				lex.autoReplace.push({ from: p.from, to: p.to, exactCase: p.exact_case ?? false, ts: new Date().toISOString() });
				record(`auto-replace: "${p.from}" → "${p.to}"`);
				return text(`Auto-replace rule added: "${p.from}" → "${p.to}".`);
			},
		}),
		tool({
			name: "inspect_term", label: "Inspect term", description: "Read an existing term's full description, aliases and matching settings before modifying it.", parameters: labelSchema,
			execute: async (_id, p) => { const term = getGraph().get(p.label); return text(term ? JSON.stringify(term) : `No term '${p.label}'.`); },
		}),
		tool({
			name: "phonetic_candidates", label: "Speech candidates",
			description: "Read phonetic/orthographic hints for raw speech; bounded text goes to the configured pronunciation backend. Scores never prove what was said and never rewrite text. Inspect evidence, rejection history and page scope; follow next offsets for omitted tokens/targets.",
			parameters: Type.Object({ token_offset: Type.Optional(Type.Integer({minimum:0})), target_offset: Type.Optional(Type.Integer({minimum:0})) }),
			execute: async (_id, p) => {
				if (!deps.voiceEvidence) throw new Error("Phonetic candidates require raw voice evidence; typed input is not speech.");
				const report = await speechCandidates(deps.voiceEvidence, Object.values(getGraph().serialize().thoughts).map(t => t.label), getSttLexicon(), {tokenOffset:p.token_offset,targetOffset:p.target_offset}, deps.phonemize, deps.signal);
				deps.assertActive?.();
				return text(JSON.stringify(report));
			},
		}),
		tool({
			name: "inspect_stt", label: "Inspect STT", description: "Read logged corrections and replacement rules for a transcribed phrase, including evidence and rejected entries.", parameters: Type.Object({transcribed: Type.String()}),
			execute: async (_id, p) => text(JSON.stringify({entries: getSttLexicon().mistranscriptions.filter(m => m.transcribed.toLowerCase() === p.transcribed.toLowerCase()), rules: getSttLexicon().autoReplace.filter(r => r.from.toLowerCase() === p.transcribed.toLowerCase())})),
		}),
		tool({
			name: "remove_auto_replace_rule", label: "Remove STT rule", description: "Disable a replacement without deleting its speech evidence.", parameters: Type.Object({from: Type.String()}),
			execute: async (_id, p) => { const lex = getSttLexicon(); lex.autoReplace = lex.autoReplace.filter(r => r.from.toLowerCase() !== p.from.toLowerCase()); record(`removed STT rule: ${p.from}`); return text("Rule removed (or already absent)."); },
		}),
		tool({
			name: "correct_mistranscription", label: "Correct STT log", description: "Correct the proposed spoken form for a logged utterance. Removes its old auto rule; a corrected rule must pass add_auto_replace_rule separately.", parameters: Type.Object({utterance_id: Type.String(), transcribed: Type.String(), spoken: Type.String()}),
			execute: async (_id, p) => { const lex = getSttLexicon(); const row = lex.mistranscriptions.find(m => m.utteranceId === p.utterance_id && m.transcribed.toLowerCase() === p.transcribed.toLowerCase()); if (!row) throw new Error("No matching utterance. Use inspect_stt to obtain its identity."); if (!p.spoken.trim()) throw new Error("Spoken form must be nonempty."); row.spoken = p.spoken.trim(); row.notes = undefined; row.status = "accepted"; lex.autoReplace = lex.autoReplace.filter(r => r.from.toLowerCase() !== p.transcribed.toLowerCase()); record(`corrected STT log: ${p.transcribed}`); return text("Log corrected; replacement disabled pending validation."); },
		}),
		tool({
			name: "reject_mistranscription", label: "Reject STT pair", description: "Reject a mistaken pairing, preserving its evidence and disabling its auto rule. Use for intentional words, nicknames or unsupported semantic corrections.", parameters: Type.Object({transcribed: Type.String(), spoken: Type.String()}),
			execute: async (_id, p) => { const lex = getSttLexicon(); const rows = lex.mistranscriptions.filter(m => m.transcribed.toLowerCase() === p.transcribed.toLowerCase() && m.spoken.toLowerCase() === p.spoken.toLowerCase()); if (!rows.length) throw new Error("No matching pair. Inspect the STT log first."); for (const row of rows) row.status = "rejected"; lex.autoReplace = lex.autoReplace.filter(r => !(r.from.toLowerCase() === p.transcribed.toLowerCase() && r.to.toLowerCase() === p.spoken.toLowerCase())); record(`rejected STT pair: ${p.transcribed}`); return text("Pair rejected; matching rule disabled." + flagExistingSttAliases(p.transcribed, p.spoken)); },
		}),
		tool({
			name: "flag_for_review",
			label: "Flag for review",
			description:
				"Record a finding that needs the human's judgment rather than an automated fix " +
				"(lexicon colonization, an LLM misspelling habit, a split too tangled to do safely).",
			parameters: flagSchema,
			execute: async (_id, p: Static<typeof flagSchema>) => {
				addFlag({
					kind: p.kind,
					label: p.label,
					description: p.description,
					ts: new Date().toISOString(),
				});
				record(`flagged ${p.kind}${p.label ? `: ${p.label}` : ""}`);
				return text(`Flagged for review (${p.kind}).`);
			},
		}),
	];
	return tools.map(t => ({ ...t, execute: async (...args: Parameters<typeof t.execute>) => {
		deps.assertActive?.();
		return t.execute(...args);
	}}));
}
