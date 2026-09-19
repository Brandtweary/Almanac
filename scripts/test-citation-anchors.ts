// Offline regression for model-written citation links: the actual main.ts anchor pass,
// and the guarantee that a restored conversation runs it.
// Run from almanac/:  node_modules/.bin/tsx scripts/test-citation-anchors.ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { EvidenceLedger, resolveCorpusCitation, validateEvidence } from "../src/corpus-tools.js";
import { GATEWAY_BASE } from "../src/local-model.js";

const source = ts.createSourceFile("main.ts", readFileSync(new URL("../src/main.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

function declaration(name: string): string {
	let text = "";
	const visit = (node: ts.Node) => {
		if (ts.isVariableStatement(node) && node.declarationList.declarations.some(d => d.name.getText(source) === name)) text ||= node.getText(source);
		ts.forEachChild(node, visit);
	};
	visit(source);
	assert.ok(text, `main.ts must declare ${name}`);
	return text;
}

// A loaded transcript emits no agent lifecycle event, so agent creation must schedule the
// anchor pass itself, unconditionally, after the chat panel adopts the restored messages.
let createAgentBody: ts.Block | undefined;
const findCreateAgent = (node: ts.Node) => {
	if (ts.isVariableDeclaration(node) && node.name.getText(source) === "createAgent" && node.initializer &&
		(ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer)) && ts.isBlock(node.initializer.body)) createAgentBody = node.initializer.body;
	ts.forEachChild(node, findCreateAgent);
};
findCreateAgent(source);
assert.ok(createAgentBody, "main.ts must declare createAgent");
const statements = createAgentBody!.statements.map(statement => statement.getText(source));
const adoption = statements.findIndex(text => text.includes("chatPanel.setAgent("));
const resolution = statements.findIndex(text => /^requestAnimationFrame\(sanitizeChatAnchors\)/.test(text));
assert.ok(adoption >= 0, "agent creation must hand the agent to the chat panel");
assert.ok(resolution > adoption, "restored citation anchors must be resolved after the chat panel adopts the agent");

class Anchor {
	attributes: Record<string, string> = {};
	textContent = "Manual";
	target = "";
	rel = "";
	title = "";
	constructor(href: string) { this.attributes.href = href; }
	getAttribute(name: string) { return this.attributes[name] ?? null; }
	setAttribute(name: string, value: string) { this.attributes[name] = value; }
	removeAttribute(name: string) { delete this.attributes[name]; }
	get href() { return this.attributes.href ?? ""; }
	set href(value: string) { this.attributes.href = value; }
}

const generation = "a".repeat(64), revision = "b".repeat(64), extraction = "c".repeat(64);
const passage = `p:${generation}:${"d".repeat(64)}`;
const evidenceLedger = new EvidenceLedger();
evidenceLedger.remember([validateEvidence({
	passage_id: passage, document_id: "manual", source_revision: revision, extraction_revision: extraction,
	title: "Manual", edition: "v1", section: [], page: { index: 0, label: "1", coordinates: null, anchor: null },
	excerpt: "Stated source text.", complete: true, previous: null, next: null, flags: [],
	source: { url: `/v1/corpus/source/${encodeURIComponent(passage)}`, sha256: revision, media_type: "text/html", origin: "fixture" },
})]);

const anchors = [
	new Anchor(`corpus:${passage}`),
	new Anchor(`corpus:p:${generation}:${"9".repeat(64)}`),
	new Anchor("javascript:alert(1)"),
	new Anchor("https://example.invalid/page"),
];
const context: Record<string, unknown> = {
	chatPanel: { querySelectorAll: () => anchors },
	evidenceLedger, resolveCorpusCitation, URL,
	window: { location: { origin: "http://localhost" } },
	GATEWAY_BASE,
};
const program = `${declaration("SAFE_HREF_SCHEME")}\n${declaration("sanitizeChatAnchors")}\nglobalThis.run = sanitizeChatAnchors;`;
vm.runInNewContext(ts.transpileModule(program, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText, context);
(context.run as () => void)();

const [known, invented, script, external] = anchors;
assert.equal(known.href, new URL(`${GATEWAY_BASE}/corpus/source/${encodeURIComponent(passage)}`, "http://localhost").href);
assert.equal(known.target, "_blank");
assert.equal(known.rel, "noopener noreferrer");
assert.equal(known.getAttribute("aria-invalid"), null);
// A handle the library never returned is never navigable and never silently plausible.
assert.equal(invented.getAttribute("href"), null);
assert.equal(invented.getAttribute("aria-invalid"), "true");
assert.match(invented.textContent, /\[unverified source\]$/);
assert.equal(script.getAttribute("href"), null);
assert.equal(external.getAttribute("href"), "https://example.invalid/page");

console.log("Citation anchors: restored transcripts resolve, verified handles navigate, invented handles are marked and inert");
