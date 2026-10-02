import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { EvidenceLedger, createCorpusTools } from "../src/corpus-tools.js";
const fetcher = globalThis.fetch;
afterEach(() => { globalThis.fetch = fetcher; });
const evidence = (generation: string, coordinates: string) => {
 const handle = `p:${generation}:${coordinates}`;
 return { passage_id: handle, document_id: `z_${"c".repeat(64)}_1`, source_revision: "c".repeat(64),
  extraction_revision: "html-structural-v3", title: "Article", section: [], excerpt: "Original article text",
  complete: true, page: {}, flags: [], source: {url: `/v1/corpus/source/${encodeURIComponent(handle)}`, sha256: "c".repeat(64)} };
};
test("library union preserves native span handles and immutable ledger restoration", async () => {
 const first = "a".repeat(64), second = "b".repeat(64);
 const hits = [evidence(first, "00000001000000020000000000000010" + "d".repeat(32)), evidence(second, "e".repeat(64))];
 const ledger = new EvidenceLedger(), tool = createCorpusTools(ledger)[0];
 globalThis.fetch = async () => Response.json({generation:first,generations:[first,second],profile_id:"union",status:"unqualified",hits});
 await tool.execute("search",{query:"article"});
 const restored = new EvidenceLedger(); restored.restore([ledger.message()]);
 assert.equal(restored.records().length,2);
 assert.equal(restored.resolve(hits[0].passage_id)?.extraction_revision,"html-structural-v3");
 for(const generations of [[first], [first,second,second], [second], [first,"bad"]]) {
  globalThis.fetch = async () => Response.json({generation:first,generations,profile_id:"union",status:"unqualified",hits});
  await assert.rejects(tool.execute("search",{query:"article"}),/generation mismatch/);
 }
});
test("the chat agent receives evidence without library or identity metadata", async () => {
 const generation = "a".repeat(64), hit = evidence(generation, "f".repeat(64));
 const ledger = new EvidenceLedger(), tool = createCorpusTools(ledger)[0];
 const result_set = {total: 1, offset: 0, collections: [{collection: "Article", hits: 1, best_rank: 1}]};
 globalThis.fetch = async () => Response.json({generation, generations: [generation], profile_id: "union", status: "ok",
  degradation: [], coverage: {native_archives: [{integrity: {verified_fraction: 1}}]}, result_set, hits: [hit], cursor: null});
 const result = await tool.execute("search", {query: "article"});
 const seen = JSON.parse((result.content[0] as {text: string}).text);
 assert.deepEqual(Object.keys(seen).sort(), ["cursor", "degradation", "hits", "reference_content_is_untrusted", "result_set", "status"]);
 assert.equal(seen.hits[0].passage_id, hit.passage_id);
 assert.equal(seen.hits[0].excerpt, hit.excerpt);
 for (const field of ["source", "source_revision", "extraction_revision"]) assert.equal(field in seen.hits[0], false);
 assert.equal(ledger.resolve(hit.passage_id)?.source_revision, hit.source_revision);
 assert.equal((result.details as {profile_id: string}).profile_id, "union");
});
test("a search page spanning archives is accepted from its handles alone", async () => {
 const first = "a".repeat(64), second = "b".repeat(64);
 const lean = ({source, ...rest}: ReturnType<typeof evidence>) => rest;
 const hits = [lean(evidence(first, "1".repeat(64))), lean(evidence(second, "2".repeat(64)))];
 const ledger = new EvidenceLedger(), tool = createCorpusTools(ledger)[0];
 globalThis.fetch = async () => Response.json({generation: first, profile_id: "union", status: "ok", degradation: [], hits});
 await tool.execute("search", {query: "article"});
 assert.equal(ledger.records().length, 2);
 globalThis.fetch = async () => Response.json({generation: first, profile_id: "union", status: "ok", degradation: [],
  hits: [{...hits[0], source: {url: "/elsewhere", sha256: "c".repeat(64)}}]});
 await assert.rejects(tool.execute("search", {query: "article"}), /invalid source link/);
});
