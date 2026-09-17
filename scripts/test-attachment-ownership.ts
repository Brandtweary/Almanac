import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";

let attachmentLoader: (file: any) => Promise<any>;
const decorator = () => () => undefined;
const dependencies = {
	LitElement: class { requestUpdate() {} }, customElement: () => (value: unknown) => value,
	property: decorator, state: decorator, createRef: () => ({}),
	loadAttachment: (file: any) => attachmentLoader(file), html: () => undefined,
};
const source = readFileSync(new URL("../src/pi-web-ui/components/MessageEditor.ts", import.meta.url), "utf8");
const js = ts.transpileModule(source, { compilerOptions: {
	target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
	experimentalDecorators: true, useDefineForClassFields: false,
} }).outputText;
const exports: Record<string, any> = {};
vm.runInNewContext(js, { exports, require: () => dependencies, console, alert: () => undefined });
const { MessageEditor } = exports;
const file = { name: "fixture.txt", size: 10 };
const attachment = { id: "fixture", fileName: "fixture.txt", mimeType: "text/plain", size: 10 };
function invoke(editor: any, source: string) {
	if (source === "picker") return editor.handleFilesSelected({ target: { files: [file], value: "fixture.txt" } });
	if (source === "drop") return editor.handleDrop({ dataTransfer: { files: [file] }, preventDefault() {}, stopPropagation() {} });
	return editor.handlePaste({ clipboardData: { items: [{ type: "image/png", getAsFile: () => file }] }, preventDefault() {} });
}
let cases = 0;
for (const first of ["picker", "drop", "paste"]) for (const second of ["picker", "drop", "paste"]) {
	const editor = new MessageEditor();
	let finish!: (value: unknown) => void;
	const gate = new Promise(resolve => { finish = resolve; });
	let calls = 0;
	attachmentLoader = async () => ++calls === 1 ? gate : attachment;
	const pending = invoke(editor, first);
	assert.equal(editor.processingFiles, true);
	await invoke(editor, second);
	assert.equal(calls, 1, `${first}/${second}: only one ingress owns attachment processing`);
	assert.equal(editor.processingFiles, true, `${first}/${second}: sending stays gated until the admitted load settles`);
	finish(attachment);
	await pending;
	assert.equal(editor.processingFiles, false);
	assert.equal(editor.attachments.length, 1);
	cases++;
}
for (const source of ["picker", "drop", "paste"]) {
	const editor = new MessageEditor();
	attachmentLoader = async () => attachment;
	editor.onFilesChange = () => { throw new Error("publication failed"); };
	await assert.rejects(invoke(editor, source), /publication failed/);
	assert.equal(editor.processingFiles, false, `${source}: a failed callback releases admission`);
	cases++;
}
console.log(`${cases} attachment ownership cases passed`);
