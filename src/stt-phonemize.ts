/** Stateless pronunciation through the configured backend; never a cloud fallback. */
export interface PhonemizeResult {
  phonemes: string[];
  engine: { name: 'espeak-ng'; version: string; voice: 'en-us' };
}
export type PhonemizeFn = (texts: string[], signal?: AbortSignal) => Promise<PhonemizeResult>;

export function makePhonemizeClient(opts: {endpoint: string; getBearer: () => string}): PhonemizeFn {
  return async (texts, signal) => {
    if (texts.length > 256 || texts.some(text => !/[\p{L}\p{N}]/u.test(text) || text.length > 64 || !/^[\p{L}\p{M}\p{N} ]+$/u.test(text))) throw new Error('Pronunciation batch exceeds the bounded Unicode text contract.');
    const bearer = opts.getBearer();
    const timeout = AbortSignal.timeout(15000);
    const response = await fetch(opts.endpoint, {
      method:'POST',headers:{'Content-Type':'application/json',...(bearer ? {Authorization:`Bearer ${bearer}`} : {})},
      body:JSON.stringify({texts,language:'en-us'}),signal:signal ? AbortSignal.any([signal,timeout]) : timeout,
    });
    if (!response.ok) throw new Error(`Phonetic hints unavailable (pronunciation service HTTP ${response.status}); ordinary transcription remains available.`);
    const value: unknown = await response.json();
    const data = value as PhonemizeResult;
    if (!data || !Array.isArray(data.phonemes) || data.phonemes.length !== texts.length || data.phonemes.some(p => typeof p !== 'string' || !p.trim() || p.length > 1024) ||
      data.engine?.name !== 'espeak-ng' || typeof data.engine.version !== 'string' || !data.engine.version.trim() || data.engine.voice !== 'en-us') throw new Error('Pronunciation service returned invalid alignment or engine identity.');
    return data;
  };
}
