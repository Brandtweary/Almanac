/** Local, read-only spelling hints. Distances nominate a contextual review, never a rewrite. */
import { stemmer } from 'stemmer';
import type { PhonemizeFn, PhonemizeResult } from './stt-phonemize.js';
import { englishWords, phrasePattern, changesNumbers, type SttLexicon, type VoiceEvidence } from './stt-lexicon.js';

export interface SpeechCandidate {
  heard: string; start: number; end: number; proposed: string; distance: number;
  provenance: Array<'vocabulary' | 'accepted-observation'>;
  utteranceIds: string[]; requiredObservations: number;
}
export interface CandidatePage {
  utteranceId: string; scorer: 'espeak-ipa-orthographic-v1'; engine: PhonemizeResult['engine'];
  candidates: SpeechCandidate[];
  scope: { tokenOffset: number; tokenEnd: number; tokenTotal: number; targetOffset: number; targetEnd: number; targetTotal: number; excludedLongTargets: number; excludedLongWindows: number };
  next: { tokenOffset: number; targetOffset: number } | null;
  resultTruncated: boolean;
}
const TOKEN_PAGE = 48, TARGET_PAGE = 256, MAX_LENGTH = 64, MAX_RESULTS = 24;
// Retained source default; candidate distance is not a calibrated confidence.
const DISTANCE_THRESHOLD = 0.18;
const stops = new Set('a an the and or but to of in on at for from with is are was were be it this that my your our their i you we they he she'.split(' '));
const fold = (s: string) => s.normalize('NFC').trim().toLowerCase();
const orth = (s: string) => fold(s).replace(/[^\p{L}\p{M}\p{N}]/gu, '');

function distance(a: string, b: string): number {
  if (!a || !b) return 1;
  let row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 0; i < a.length; i++) {
    const next = [i + 1];
    for (let j = 0; j < b.length; j++) next.push(Math.min(next[j] + 1, row[j + 1] + 1, row[j] + (a[i] === b[j] ? 0 : 1)));
    row = next;
  }
  return row[b.length] / Math.max(a.length, b.length);
}
const nuclei = /[aeiouyɑɒæɐəɘɚɛɜɝɞɤɨɪɔœøɵʉʊʌ]+/gu;
const syllables = (ipa: string) => (ipa.match(nuclei) ?? []).length;
const pairKey = (a: string, b: string) => JSON.stringify([fold(a), fold(b)]);

/** Slug formatting and grammatical variants are not transcription errors. */
function sameTerm(heard: string, proposed: string): boolean {
  const a=fold(heard), b=fold(proposed);
  if (a.replace(/['’]/g,'')===b.replace(/['’]/g,'')) return true;
  if (a.replace(/\s+/g,' ')===b.replace(/[-_]+/g,' ').replace(/\s+/g,' ')) return true;
  const tokens=(s:string)=>s.match(/[\p{L}\p{M}\p{N}]+/gu) ?? [];
  const left=tokens(a),right=tokens(b);
  const equal=(a:string[],b:string[])=>a.length===b.length && a.every((t,i)=>t===b[i]);
  if (!left.length || !right.length) return false;
  const articles=new Set(['a','an','the']);
  if ((articles.has(left[0]!) && equal(left.slice(1),right)) || (articles.has(right[0]!) && equal(right.slice(1),left))) return true;
  const ls=left.map(stemmer),rs=right.map(stemmer);
  if (equal(ls,rs) || (ls.length<rs.length && ls.join('')===rs.join(''))) return true;
  const [short,long]=ls.length<rs.length ? [ls,rs] : [rs,ls];
  return long.length>short.length && short.every((t,i)=>t===long[i]);
}

export async function speechCandidates(evidence: VoiceEvidence, vocabulary: string[], lex: SttLexicon,
  page: { tokenOffset?: number; targetOffset?: number } = {}, phonemize?: PhonemizeFn, signal?: AbortSignal): Promise<CandidatePage> {
  if (!phonemize) throw new Error('Phonetic hints unavailable: no pronunciation service configured; ordinary transcription remains available.');
  const tokenOffset = page.tokenOffset ?? 0, targetOffset = page.targetOffset ?? 0;
  if (![tokenOffset, targetOffset].every(v => Number.isSafeInteger(v) && v >= 0)) throw new Error('Candidate offsets must be nonnegative integers.');
  const words = await englishWords();
  const rejected = new Set(lex.mistranscriptions.filter(r => r.status === 'rejected').map(r => pairKey(r.transcribed, r.spoken)));
  const observations = new Map<string, Set<string>>(), canonical = new Set<string>();
  const targets = new Map<string, {label: string; provenance: SpeechCandidate['provenance']}>();
  for (const row of lex.mistranscriptions) {
    if (row.status === 'rejected' || rejected.has(pairKey(row.transcribed, row.spoken)) || !row.utteranceId || !row.rawText || !row.transcribed.trim() || !row.spoken.trim() || !phrasePattern(row.transcribed).test(row.rawText)) continue;
    const key = pairKey(row.transcribed, row.spoken);
    const ids = observations.get(key) ?? new Set<string>(); ids.add(row.utteranceId); observations.set(key, ids);
    canonical.add(fold(row.spoken));
    targets.set(fold(row.spoken), {label: row.spoken, provenance: ['accepted-observation']});
  }
  for (const label of vocabulary) {
    if (!label.trim()) continue;
    const prior = targets.get(fold(label));
    if (prior) { if (!prior.provenance.includes('vocabulary')) prior.provenance.push('vocabulary'); }
    else targets.set(fold(label), {label, provenance: ['vocabulary']});
  }
  const allTargets = [...targets.values()].sort((a,b) => fold(a.label).localeCompare(fold(b.label)));
  const excludedLongTargets = allTargets.filter(t => t.label.length > MAX_LENGTH).length;
  const eligible = allTargets.filter(t => t.label.length <= MAX_LENGTH);
  const tokenMatches = [...evidence.rawText.matchAll(/[\p{L}\p{M}\p{N}]+(?:['’][\p{L}\p{M}]+)*/gu)];
  if (tokenOffset > tokenMatches.length || targetOffset > eligible.length) throw new Error('Candidate offset is outside this snapshot.');
  const tokenEnd = Math.min(tokenOffset + TOKEN_PAGE, tokenMatches.length), targetEnd = Math.min(targetOffset + TARGET_PAGE, eligible.length);
  const selected = eligible.slice(targetOffset, targetEnd), candidates: SpeechCandidate[] = [];
  const sanitize = (text: string) => {
    const normalized=text.normalize('NFC').replace(/[^\p{L}\p{M}\p{N} ]/gu,' ').replace(/\s+/g,' ').trim();
    return /[\p{L}\p{N}]/u.test(normalized) ? normalized : '';
  };
  const requests = new Set(selected.map(t => sanitize(t.label)).filter(Boolean));
  for (let i = tokenOffset; i < tokenEnd; i++) for (let n = 1; n <= 3 && i+n <= tokenMatches.length; n++) {
    const first=tokenMatches[i],last=tokenMatches[i+n-1];
    const value=sanitize(orth(evidence.rawText.slice(first.index!,last.index!+last[0].length)));
    if (value && value.length <= MAX_LENGTH) requests.add(value);
  }
  const inputs=[...requests], pronunciations=new Map<string,string>();
  let engine: PhonemizeResult['engine'] | undefined;
  for (let i=0; i<inputs.length || (i===0 && !inputs.length); i+=256) {
    signal?.throwIfAborted();
    const batch=inputs.slice(i,i+256), result=await phonemize(batch,signal);
    signal?.throwIfAborted();
    if (result.phonemes.length !== batch.length) throw new Error('Pronunciation alignment mismatch.');
    if (engine && JSON.stringify(engine)!==JSON.stringify(result.engine)) throw new Error('Pronunciation engine changed during candidate generation; retry.');
    engine=result.engine;
    batch.forEach((input,j)=>pronunciations.set(input,result.phonemes[j].replace(/[ˈˌ\s]+/gu,'')));
    if (!inputs.length) break;
  }
  const ipa = (text:string) => pronunciations.get(sanitize(text)) ?? '';
  let excludedLongWindows = 0;
  for (let i = tokenOffset; i < tokenEnd; i++) for (let n = 1; n <= 3 && i + n <= tokenMatches.length; n++) {
    const first = tokenMatches[i], last = tokenMatches[i+n-1], start = first.index!, end = last.index! + last[0].length;
    if (n > 1 && (stops.has(fold(first[0])) || stops.has(fold(last[0])))) continue;
    if (n > 1 && tokenMatches.slice(i, i+n-1).some((t,j) => !/^[\s-]+$/.test(evidence.rawText.slice(t.index! + t[0].length, tokenMatches[i+j+1].index!)))) continue;
    const heard = evidence.rawText.slice(start,end);
    if (heard.length > MAX_LENGTH) { excludedLongWindows++; continue; }
    if (canonical.has(fold(heard)) || /\p{N}/u.test(heard)) continue;
    const common = n === 1 && words.has(fold(heard));
    const restricted = common || orth(heard).length < 4;
    for (const target of selected) {
      const proposed = target.label, key = pairKey(heard, proposed), ids = [...(observations.get(key) ?? [])].sort();
      const required = common ? 2 : 1;
      if (fold(heard) === fold(proposed) || rejected.has(key) || changesNumbers(heard, proposed)) continue;
      if (restricted && ids.length < required) continue;
      if (sameTerm(heard,proposed)) continue;
      const queryIpa = ipa(orth(heard)), targetIpa = ipa(proposed);
      if (queryIpa && targetIpa && Math.abs(syllables(queryIpa) - syllables(targetIpa)) > 1) continue;
      const d = Math.min(distance(orth(heard), orth(proposed)), distance(queryIpa, targetIpa));
      if (d > DISTANCE_THRESHOLD) continue;
      candidates.push({heard,start,end,proposed,distance:d,provenance:target.provenance,utteranceIds:ids,requiredObservations:required});
    }
  }
  candidates.sort((a,b) => a.distance-b.distance || (b.end-b.start)-(a.end-a.start) || a.start-b.start || a.proposed.localeCompare(b.proposed));
  const accepted: SpeechCandidate[] = [];
  for (const candidate of candidates) {
    if (accepted.some(a => a.start < candidate.end && candidate.start < a.end && (a.start !== candidate.start || a.end !== candidate.end))) continue;
    if (accepted.filter(a => a.start === candidate.start && a.end === candidate.end).length < 3) accepted.push(candidate);
  }
  const next = targetEnd < eligible.length ? {tokenOffset, targetOffset:targetEnd} : tokenEnd < tokenMatches.length ? {tokenOffset:tokenEnd,targetOffset:0} : null;
  return {utteranceId:evidence.utteranceId,scorer:'espeak-ipa-orthographic-v1',engine:engine!,candidates:accepted.slice(0,MAX_RESULTS),
    scope:{tokenOffset,tokenEnd,tokenTotal:tokenMatches.length,targetOffset,targetEnd,targetTotal:eligible.length,excludedLongTargets,excludedLongWindows},next,resultTruncated:accepted.length>MAX_RESULTS};
}
