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
