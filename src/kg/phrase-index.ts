interface Output<T> { length: number; value: T }
interface State<T> { edges: Map<string, number>; fail: number; output: Output<T>[] }
const word = /[\p{L}\p{N}_]/u;
function before(text: string, offset: number): string {
  if (!offset) return "";
  const last = text.charCodeAt(offset - 1);
  return text.slice(last >= 0xdc00 && last <= 0xdfff ? offset - 2 : offset - 1, offset);
}

/** Aho-Corasick phrase lookup with the matcher's Unicode token boundaries. */
export class PhraseIndex<T> {
  private states: State<T>[] = [{ edges: new Map(), fail: 0, output: [] }];

  get isEmpty(): boolean { return this.states.length === 1; }

  constructor(patterns: Iterable<readonly [string, T]>) {
    for (const [pattern, value] of patterns) {
      if (!pattern) continue;
      let state = 0;
      for (let i = 0; i < pattern.length; i++) {
        const char = pattern[i];
        let next = this.states[state].edges.get(char);
        if (next === undefined) {
          next = this.states.length;
          this.states[state].edges.set(char, next);
          this.states.push({ edges: new Map(), fail: 0, output: [] });
        }
        state = next;
      }
      this.states[state].output.push({ length: pattern.length, value });
    }
    const queue = [...this.states[0].edges.values()];
    for (let cursor = 0; cursor < queue.length; cursor++) {
      const parent = queue[cursor];
      for (const [char, child] of this.states[parent].edges) {
        let fallback = this.states[parent].fail;
        while (fallback && !this.states[fallback].edges.has(char)) fallback = this.states[fallback].fail;
        this.states[child].fail = this.states[fallback].edges.get(char) ?? 0;
        this.states[child].output.push(...this.states[this.states[child].fail].output);
        queue.push(child);
      }
    }
  }

  match(text: string): Set<T> {
    const found = new Set<T>();
    if (this.isEmpty) return found;
    let state = 0;
    for (let i = 0; i < text.length; i++) {
      const char = text[i];
      while (state && !this.states[state].edges.has(char)) state = this.states[state].fail;
      state = this.states[state].edges.get(char) ?? 0;
      for (const output of this.states[state].output) {
        const end = i + 1, start = end - output.length;
        const next = text.codePointAt(end);
        if (!word.test(before(text, start)) && (next === undefined || !word.test(String.fromCodePoint(next)))) found.add(output.value);
      }
    }
    return found;
  }
}
