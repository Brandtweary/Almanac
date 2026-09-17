import DOMPurify from "dompurify";
import katex from "katex";
import { Marked } from "marked";
import { html, LitElement } from "lit";
import { customElement, property } from "lit/decorators.js";
import { unsafeHTML } from "lit/directives/unsafe-html.js";

const escapeHTML = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const markdown = new Marked({ renderer: {
	html: ({ text }) => escapeHTML(text),
	code: ({ text, lang }) => {
		const language = /^[-\w]+$/.test(lang ?? "") ? lang : "text";
		const code = btoa(Array.from(new TextEncoder().encode(text), byte => String.fromCharCode(byte)).join(""));
		return `<code-block language="${language}" code="${code}"></code-block>`;
	},
} });
for (const [name, expression, displayMode] of [
	["displayMath", /^\$\$([\s\S]+?)\$\$/, true],
	["inlineMath", /^\$([^$\n]+?)\$/, false],
	["displayMathBrackets", /^\\\[([\s\S]+?)\\\]/, true],
	["inlineMathParentheses", /^\\\(([\s\S]+?)\\\)/, false],
] as const) markdown.use({ extensions: [{
	name, level: "inline", start: src => src.search(/[$\\]/),
	tokenizer(src) { const match = expression.exec(src); return match ? { type: name, raw: match[0], text: match[1] } : undefined; },
	renderer(token) { return katex.renderToString(token.text, { throwOnError: false, trust: false, displayMode, output: "mathml" }); },
}] });

/** No active HTML or external resources enter the conversation DOM. */
export function safeMarkdown(content: string): string {
	return DOMPurify.sanitize(markdown.parse(content, { async: false }), {
		ALLOWED_TAGS: ["p", "br", "hr", "h1", "h2", "h3", "h4", "h5", "h6", "strong", "b", "em", "i", "s", "del", "blockquote", "pre", "code", "ul", "ol", "li", "table", "thead", "tbody", "tr", "th", "td", "a", "span", "div", "sup", "sub", "math", "semantics", "annotation", "mrow", "mi", "mn", "mo", "mtext", "mspace", "mfrac", "msqrt", "mroot", "msub", "msup", "msubsup", "munder", "mover", "munderover", "mtable", "mtr", "mtd", "menclose", "mpadded", "mstyle"],
		ALLOWED_ATTR: ["href", "title", "class", "colspan", "rowspan", "start", "display", "encoding", "mathvariant", "stretchy", "fence", "separator", "accent", "accentunder", "columnalign", "rowspacing", "columnspacing", "displaystyle", "scriptlevel", "language", "code"],
		ALLOW_DATA_ATTR: false, ALLOW_ARIA_ATTR: false,
		CUSTOM_ELEMENT_HANDLING: { tagNameCheck: /^code-block$/, attributeNameCheck: /^(language|code)$/ },
		// Corpus citations are relative source handles, resolved against the evidence ledger.
		ALLOWED_URI_REGEXP: /^(?:https?:|mailto:|corpus:|\/v1\/corpus\/)/i,
	});
}

@customElement("safe-markdown")
export class SafeMarkdown extends LitElement {
	@property() content = "";
	@property({ type: Boolean }) isThinking = false;
	protected createRenderRoot() { return this; }
	connectedCallback() { super.connectedCallback(); this.classList.add("markdown-content"); this.style.display = "block"; }
	render() { return html`<div class=${this.isThinking ? "text-muted-foreground italic max-w-none break-words overflow-wrap-anywhere text-sm [&>*:last-child]:!mb-0" : "text-foreground max-w-none break-words overflow-wrap-anywhere [&>*:last-child]:!mb-0"}>${unsafeHTML(safeMarkdown(this.content))}</div>`; }
}
