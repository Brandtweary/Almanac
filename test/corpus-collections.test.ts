import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { EvidenceLedger, createCorpusTools, renderLibrary } from "../src/corpus-tools.js";
const fetcher = globalThis.fetch;
afterEach(() => { globalThis.fetch = fetcher; });
const collection = (values: Partial<Parameters<typeof renderLibrary>[0][number]>) => ({
 category: "", title: "Archive", publisher: "", origin: "https://example.org", language: "en",
 articles: null, works: [], additional_works: 0, indexing_complete: true, packs: ["pack"], ...values });
const listing = (collections: unknown[]) =>
 Response.json({generation: "a".repeat(64), profile_id: "listing", status: "ok", degradation: [], collections});

test("a categorized collection is listed under its category as sub-bullets", () => {
 const text = renderLibrary([
  collection({title: "English Wikipedia", publisher: "Wikimedia contributors", articles: 6912043}),
  collection({category: "Scripture and canon", title: "English Wikisource", articles: 1204102}),
  collection({category: "Scripture and canon", title: "Pali Canon", articles: 40312, indexing_complete: false}),
 ]);
 assert.equal(text.split("\n\n")[1], [
  "- English Wikipedia — Wikimedia contributors · 6,912,043 articles",
  "- Scripture and canon",
  "  - English Wikisource — 1,204,102 articles",
  "  - Pali Canon — 40,312 articles · semantic indexing still in progress",
 ].join("\n"));
});

test("a pack's works are named beneath it and the remainder is counted", () => {
 const text = renderLibrary([collection({category: "Scripture and canon", title: "tracts",
  works: ["Tract 0", "Tract 1"], additional_works: 3})]);
 assert.match(text, /\n {2}- tracts\n {4}- Tract 0\n {4}- Tract 1\n {4}- and 3 further works/);
});

test("an empty library says so rather than listing nothing", () => {
 assert.match(renderLibrary([]), /no installed collections/);
});

test("the listing tool reads the gateway and refuses a damaged one", async () => {
 const tool = createCorpusTools(new EvidenceLedger()).find(t => t.name === "corpus_collections")!;
 let requested = "";
 globalThis.fetch = (async (url: string) => { requested = String(url); return listing([collection({title: "CD3WD"})]); }) as typeof fetch;
 const result = await tool.execute("listing", {});
 assert.match(requested, /\/corpus\/collections$/);
 assert.match(result.content[0]!.text, /- CD3WD/);

 globalThis.fetch = (async () => listing([{title: 42}])) as typeof fetch;
 await assert.rejects(tool.execute("listing", {}), /invalid library listing/);
 globalThis.fetch = (async () => Response.json({generation: "a".repeat(64), profile_id: "listing"})) as typeof fetch;
 await assert.rejects(tool.execute("listing", {}), /invalid library listing/);
});

test("an unavailable library service is reported as a failed listing", async () => {
 const tool = createCorpusTools(new EvidenceLedger()).find(t => t.name === "corpus_collections")!;
 globalThis.fetch = (async () => Response.json({error: {code: "corpus_timeout"}}, {status: 504})) as typeof fetch;
 await assert.rejects(tool.execute("listing", {}), /Corpus listing exceeded its deadline\. .*Retry it\./s);
});
