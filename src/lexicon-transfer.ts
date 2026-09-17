/** Portable personal-memory data; in-flight jobs and execution authority are not exported. */
import { Graph } from './kg/graph.js';
import type { GraphAsset } from './kg/types.js';
import { emptyMaintenance, validateMaintenance, type MaintenanceState } from './glossary-maintenance.js';
import { validateMemoryArchive, type MemoryArchiveRecord } from './memory-archive.js';
import type { MemoryStorage } from './memory-storage.js';
import { validateSttLexicon, validateRunningContext } from './memory-state.js';
import { emptySttLexicon, validateAutoReplace, type SttLexicon } from './stt-lexicon.js';
import type { PipelineSnapshot, RunningContextEntry } from './pipeline.js';

export interface LexiconAsset {
  lexicon_version: 1;
  terms: GraphAsset;
  stt: SttLexicon;
  running_context: RunningContextEntry[];
  archive?: MemoryArchiveRecord[];
  maintenance?: MaintenanceState;
}
export interface LexiconReplacement {
  graph: Graph;
  sttLexicon: SttLexicon;
  runningContext: RunningContextEntry[];
  archive: MemoryArchiveRecord[];
  maintenance: MaintenanceState;
}

export function makeLexiconAsset(saved: Awaited<ReturnType<MemoryStorage['exportData']>>): LexiconAsset {
  const state=saved.pipeline.present ? saved.pipeline.value as PipelineSnapshot : undefined;
  const maintenance=state?.maintenance ?? emptyMaintenance();
  validateMaintenance(maintenance);
  return structuredClone({
    lexicon_version:1,
    terms:saved.graph.present ? saved.graph.value as GraphAsset : Graph.empty().serialize(),
    stt:state?.sttLexicon ?? (saved.legacyPipeline['stt-lexicon'].present ? saved.legacyPipeline['stt-lexicon'].value as SttLexicon : emptySttLexicon()),
    running_context:state?.runningContext ?? (saved.legacyPipeline['running-context'].present ? saved.legacyPipeline['running-context'].value as RunningContextEntry[] : []),
    archive:saved.archive,maintenance,
  });
}

/** Validate the whole uploaded asset before invalidating live memory or beginning writes. */
export async function parseLexiconAsset(value: unknown): Promise<LexiconReplacement> {
  if (!value || typeof value!=='object' || Array.isArray(value)) throw new Error('not a valid lexicon export');
  const asset=value as LexiconAsset;
  if (!asset.terms || typeof asset.terms.thoughts!=='object') throw new Error('not a valid lexicon export');
  if (asset.lexicon_version!==1) throw new Error('Unsupported lexicon version');
  const graph=new Graph(asset.terms), sttLexicon=asset.stt ?? emptySttLexicon(), runningContext=asset.running_context ?? [];
  const archive=asset.archive ?? [], maintenance=asset.maintenance === undefined ? emptyMaintenance() : asset.maintenance;
  validateSttLexicon(sttLexicon); validateRunningContext(runningContext); validateMemoryArchive(archive); validateMaintenance(maintenance);
  for (const rule of sttLexicon.autoReplace) await validateAutoReplace(rule.from,rule.to,rule.exactCase);
  return {graph,...structuredClone({sttLexicon,runningContext,archive,maintenance})};
}

export function replacementPipeline(replacement: LexiconReplacement, generation: number): PipelineSnapshot {
  return structuredClone({generation,jobs:[],buffers:{audit:[],memory:[],summary:[]},flags:[],
    sttLexicon:replacement.sttLexicon,runningContext:replacement.runningContext,maintenance:replacement.maintenance});
}
