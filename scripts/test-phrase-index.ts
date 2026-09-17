import assert from "node:assert/strict";
import { test } from "node:test";
import { PhraseIndex } from "../src/kg/phrase-index.js";
import { Graph } from "../src/kg/graph.js";
import { escapeRegExp } from "../src/regex-utils.js";

test("indexed phrase matches equal the literal Unicode-boundary reference", () => {
  const patterns = ["water wheel", "wheel", "c++", "c#", ".net", "灌溉 水", "𐐀 pump", "e\u0301 pipe", "a.b", "aba", "ba", "she", "he", "hers"];
  const index = new PhraseIndex(patterns.map((p, i) => [p, i] as const));
  const texts = ["water wheel", "water wheels", "c++ c# .net", "xc++ .network c#x", "灌溉 水", "a𐐀 pump", "𐐀 pump!", "e\u0301 pipe", "a.b aXb", "aba ba", "she hers he", "water wheel_", "𐐀water wheel𐐀"];
  for (const text of texts) {
    const reference = patterns.flatMap((pattern, i) => new RegExp(`(?<![\\p{L}\\p{N}_])${escapeRegExp(pattern)}(?![\\p{L}\\p{N}_])`, "u").test(text) ? [i] : []);
    assert.deepEqual([...index.match(text)].sort((a, b) => a - b), reference, text);
  }
});

test("shared suffixes and duplicate patterns retain all associated values", () => {
  const index = new PhraseIndex([["water wheel", 1], ["wheel", 2], ["water wheel", 3], ["wheel", 4]]);
  assert.deepEqual([...index.match("water wheel")].sort(), [1, 2, 3, 4]);
});

test("graph rebuilds indexes after aliases, renames, descriptions and removals", () => {
  const graph = Graph.empty();
  graph.getOrCreate("water-wheel", "A powered wheel.");
  assert.equal(graph.termMatch("water wheels")[0].label, "water-wheel");
  graph.addAlias("water-wheel", "mill rotor");
  assert.equal(graph.termMatch("mill rotor")[0].matched_via, "alias");
  graph.rename("water-wheel", "mill-wheel");
  assert.equal(graph.termMatch("mill rotor")[0].label, "mill-wheel");
  graph.getOrCreate("mill-wheel", "A revised wheel.");
  assert.equal(graph.termMatch("mill rotor")[0].description, "A revised wheel.");
  graph.remove("mill-wheel");
  assert.deepEqual(graph.termMatch("mill rotor"), []);
});
