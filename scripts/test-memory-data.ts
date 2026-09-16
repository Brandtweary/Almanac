import assert from "node:assert/strict";
import { retrieve } from "../src/kg/retrieve.ts";
import { InjectedLedger } from "../src/kg/ledger.ts";
import { Graph } from "../src/kg/graph.ts";
import { makeEmbedClient } from "../src/kg/embed.ts";
import { cosineSimilarity, findSimilarTerms } from "../src/kg/similarity.ts";

const graph = Graph.empty();
const term = graph.getOrCreate("irrigation", "Watering crops.");
const asset = graph.serialize();
const invalidRows: unknown[] = [null, { ...term, aliases: [5] }, { ...term, description: 5 },
	{ ...term, hit_count: -1 }, { ...term, metadata: { no_stem: "yes" } }, { ...term, id: "wrong" }];
for (const row of invalidRows) {
	assert.throws(() => new Graph({ ...asset, thoughts: { [term.id]: row } } as never));
}
assert.throws(() => new Graph(null as never));
assert.throws(() => new Graph({ ...asset, meta: { ...asset.meta, node_count: 2 } }));
assert.throws(() => new Graph({ ...asset, meta: { ...asset.meta, node_count: 2 },
	thoughts: { [term.id]: term, other: { ...term, id: "other" } } }));
const reloaded = new Graph(asset);
term.aliases.push("watering");
assert.deepEqual(reloaded.get("irrigation")!.aliases, [], "loading cannot retain caller-owned alias arrays");
for (const vector of [[1, 2], [1, NaN], [1, Infinity], [0, 0], [1, "2"]]) {
	const imported = new Graph({ ...asset, thoughts: { [term.id]: { ...term, embedding: vector as number[] } } });
	assert.equal(imported.get("irrigation")!.embedding, null);
	assert.equal(imported.get("irrigation")!.description, "Watering crops.");
}
term.embedding = [1, 0];
term.embedding_encoder = "model-a@revision:mean";
assert.equal(findSimilarTerms(graph, "aqueduct", { vector: [1, 0], encoder: "model-b@revision:mean" }).length, 0);
assert.equal(findSimilarTerms(graph, "aqueduct", { vector: [1, 0], encoder: term.embedding_encoder }).length, 1);
assert.equal(findSimilarTerms(graph, "aqueduct", { vector: [1, 0, 0], encoder: term.embedding_encoder }).length, 0);
assert.equal(cosineSimilarity([NaN, 1], [1, 1]), 0);

const originalFetch = globalThis.fetch;
let response: unknown = { encoder: "model-a@revision:mean", embeddings: [[1, 0]] };
let body: { inputs: string[]; truncate: boolean } | undefined;
globalThis.fetch = async (_input, init) => {
	body = JSON.parse(init!.body as string);
	return new Response(JSON.stringify(response), { status: 200 });
};
try {
	const embed = makeEmbedClient({ endpoint: "https://example.invalid/embed", getBearer: () => "" });
	assert.deepEqual(await embed("full label: full description"), { encoder: "model-a@revision:mean", vector: [1, 0] });
	assert.deepEqual(body, { inputs: ["full label: full description"], truncate: false });
	for (const malformed of [null, [[1, 0]], { encoder: "", embeddings: [[1, 0]] },
		{ encoder: "model", embeddings: [[1, 0], [0, 1]] }, { encoder: "model", embeddings: [[1, "x"]] },
		{ encoder: "model", embeddings: [[0, 0]] }, { encoder: "model", embeddings: [[]] }]) {
		response = malformed;
		assert.equal(await embed("input"), null);
	}
} finally {
	globalThis.fetch = originalFetch;
}

const ledger = new InjectedLedger();
assert.ok(retrieve(graph, ledger, "irrigation").injectionBlock);
assert.equal(retrieve(graph, ledger, "irrigation").injectionBlock, null);
graph.getOrCreate("irrigation", "Delivering water to roots.");
assert.ok(retrieve(graph, ledger, "irrigation").injectionBlock?.includes("Delivering water to roots."));
assert.equal(retrieve(graph, ledger, "irrigation").injectionBlock, null);



const routes = Graph.empty();
routes.getOrCreate("irrigation", "Water for crops.");
routes.addAlias("irrigation", "water-channels");
const aliasMatch = routes.termMatch("water channels")[0];
assert.equal(aliasMatch.matched_surface, "water-channels");
assert.equal(aliasMatch.matched_via, "alias");
const directMatch = routes.termMatch("water channels for irrigation")[0];
assert.equal(directMatch.matched_surface, "irrigation");
assert.equal(directMatch.matched_via, "label");
const evidence = retrieve(routes, new InjectedLedger(), "water channels").injectionBlock;
assert.ok(evidence?.includes('indexed alias "water-channels"'));
routes.getOrCreate("c++", "A programming language.");
assert.equal(routes.termMatch("c++")[0].matched_surface, "c++");

console.log("Memory import, embeddings, retrieval ledger and route provenance tests passed.");
