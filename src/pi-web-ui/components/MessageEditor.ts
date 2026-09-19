import { MAX_ATTACHMENTS, MAX_ATTACHMENT_BYTES, validAttachments } from "../../attachment-limits.js";
import { EDITOR_READY_EVENT } from "../../editor-controls.js";
import type { Model } from "@earendil-works/pi-ai";
import { icon } from "@mariozechner/mini-lit";
import { Button } from "@mariozechner/mini-lit/dist/Button.js";
import { Select, type SelectOption } from "@mariozechner/mini-lit/dist/Select.js";
import { html, LitElement } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { createRef, ref } from "lit/directives/ref.js";
import { Brain, Loader2, Paperclip, Send, Sparkles, Square } from "lucide";
import { type Attachment, loadAttachment } from "../utils/attachment-utils.js";
import { i18n } from "../utils/i18n.js";
import "./AttachmentTile.js";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";

@customElement("message-editor")
export class MessageEditor extends LitElement {
	private _value = "";
	private textareaRef = createRef<HTMLTextAreaElement>();

	@property()
	get value() {
		return this._value;
	}

	set value(val: string) {
		const oldValue = this._value;
		this._value = val;
		this.requestUpdate("value", oldValue);
	}

	public insertSuggestion(text: string): boolean {
		if (this.disabled || this.isStreaming || this.processingFiles || this.value !== "" || this.attachments.length) return false;
		this.value = text;
		this.textareaRef.value?.focus();
		return true;
	}

	@property() isStreaming = false;
	@property({ type: Boolean }) disabled = false;
	@property() currentModel?: Model<any>;
	@property() thinkingLevel: ThinkingLevel = "off";
	@property() showAttachmentButton = true;
	@property() showModelSelector = true;
	@property() showThinkingSelector = true;
	@property() onInput?: (value: string) => void;
	@property() onSend?: (input: string, attachments: Attachment[]) => void;
	@property() onAbort?: () => void;
	@property() onModelSelect?: () => void;
	@property() onThinkingChange?: (level: "off" | "minimal" | "low" | "medium" | "high") => void;
	@property() onFilesChange?: (files: Attachment[]) => void;
	@property() attachments: Attachment[] = [];
	@property() maxFiles = MAX_ATTACHMENTS;
	@property() maxFileSize = MAX_ATTACHMENT_BYTES;
	@property() acceptedTypes =
		"image/*,application/pdf,.docx,.pptx,.xlsx,.xls,.txt,.md,.json,.xml,.html,.css,.js,.ts,.jsx,.tsx,.yml,.yaml";

	@state() processingFiles = false;
	@state() isDragging = false;
	private fileInputRef = createRef<HTMLInputElement>();

	protected override createRenderRoot(): HTMLElement | DocumentFragment {
		return this;
	}

	private handleTextareaInput = (e: Event) => {
		const textarea = e.target as HTMLTextAreaElement;
		this.value = textarea.value;
		this.onInput?.(this.value);
	};

	private handleKeyDown = (e: KeyboardEvent) => {
		if (this.disabled) return;
		// Ignore key events during IME composition (e.g. CJK input)
		if (e.isComposing || e.key === "Process") return;

		if (e.key === "Enter" && !e.shiftKey) {
			e.preventDefault();
			if (!this.isStreaming && !this.processingFiles && (this.value.trim() || this.attachments.length > 0)) {
				this.handleSend();
			}
		} else if (e.key === "Escape" && this.isStreaming) {
			e.preventDefault();
			this.onAbort?.();
		}
	};

	private async ingestFiles(files: File[]): Promise<void> {
		if (this.disabled) return;
		if (this.processingFiles) return;
		if (!files.length) return;
		if (files.length + this.attachments.length > this.maxFiles) {
			alert(`Maximum ${this.maxFiles} files allowed`);
			return;
		}
		this.processingFiles = true;
		try {
			const added: Attachment[] = [];
			for (const file of files) {
				try {
					if (file.size > this.maxFileSize) {
						alert(`${file.name} exceeds maximum size of ${Math.round(this.maxFileSize / 1024 / 1024)}MB`);
						continue;
					}
					const attachment = await loadAttachment(file);
					if (!validAttachments([...this.attachments, ...added, attachment])) throw new Error("Attachment content exceeds the supported limits");
					added.push(attachment);
				} catch (error) {
					console.error(`Error processing ${file.name}:`, error);
					alert(`Failed to process ${file.name}: ${String(error)}`);
				}
			}
			this.attachments = [...this.attachments, ...added];
			this.onFilesChange?.(this.attachments);
		} finally {
			this.processingFiles = false;
		}
	}

	private handlePaste = async (e: ClipboardEvent) => {
		const files: File[] = [];
		for (const item of Array.from(e.clipboardData?.items ?? [])) {
			if (item.type.startsWith("image/")) {
				const file = item.getAsFile();
				if (file) files.push(file);
			}
		}
		if (!files.length) return;
		e.preventDefault();
		await this.ingestFiles(files);
	};

	private handleSend = () => {
		if (this.disabled) return;
		this.onSend?.(this.value, this.attachments);
	};

	private handleAttachmentClick = () => {
		this.fileInputRef.value?.click();
	};

	private async handleFilesSelected(e: Event) {
		const input = e.target as HTMLInputElement;
		try {
			await this.ingestFiles(Array.from(input.files ?? []));
		} finally {
			input.value = "";
		}
	}

	private removeFile(fileId: string) {
		this.attachments = this.attachments.filter((f) => f.id !== fileId);
		this.onFilesChange?.(this.attachments);
	}

	private handleDragOver = (e: DragEvent) => {
		e.preventDefault();
		e.stopPropagation();
		if (!this.isDragging) {
			this.isDragging = true;
		}
	};

	private handleDragLeave = (e: DragEvent) => {
		e.preventDefault();
		e.stopPropagation();
		// Only set isDragging to false if we're leaving the entire component
		const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
		const x = e.clientX;
		const y = e.clientY;
		if (x <= rect.left || x >= rect.right || y <= rect.top || y >= rect.bottom) {
			this.isDragging = false;
		}
	};

	private handleDrop = async (e: DragEvent) => {
		e.preventDefault();
		e.stopPropagation();
		this.isDragging = false;
		await this.ingestFiles(Array.from(e.dataTransfer?.files ?? []));
	};

	override updated(changed: Map<string, unknown>) {
		if (["value", "attachments", "processingFiles"].some(key => changed.has(key))) {
			this.dispatchEvent(new CustomEvent("composer-draft-change", { bubbles: true,
				detail: this.value !== "" || this.attachments.length > 0 || this.processingFiles }));
		}
	}

	override firstUpdated() {
		this.dispatchEvent(new CustomEvent(EDITOR_READY_EVENT, { bubbles: true }));
		const textarea = this.textareaRef.value;
		if (textarea) {
			textarea.focus();
		}
	}

	override render() {
		// Check if current model supports thinking/reasoning
		const model = this.currentModel;
		const supportsThinking = model?.reasoning === true; // Models with reasoning:true support thinking

		return html`
			<div
				class="bg-card rounded-xl border shadow-sm relative ${this.isDragging ? "border-primary border-2 bg-primary/5" : "border-border"}"
				@dragover=${this.handleDragOver}
				@dragleave=${this.handleDragLeave}
				@drop=${this.handleDrop}
			>
				<!-- Drag overlay -->
				${
					this.isDragging
						? html`
					<div class="absolute inset-0 bg-primary/10 rounded-xl pointer-events-none z-10 flex items-center justify-center">
						<div class="text-primary font-medium">${i18n("Drop files here")}</div>
					</div>
				`
						: ""
				}

				<!-- Attachments -->
				${
					this.attachments.length > 0
						? html`
							<div class="px-4 pt-3 pb-2 flex flex-wrap gap-2">
								${this.attachments.map(
									(attachment) => html`
										<attachment-tile
											.attachment=${attachment}
											.showDelete=${true}
											.onDelete=${() => this.removeFile(attachment.id)}
										></attachment-tile>
									`,
								)}
							</div>
						`
						: ""
				}

				<textarea
					?disabled=${this.disabled}
					class="w-full bg-transparent p-4 text-foreground placeholder-muted-foreground outline-none resize-none overflow-y-auto"
					placeholder="Ask a question…"
					rows="1"
					style="max-height: 200px; field-sizing: content; min-height: 1lh; height: auto;"
					.value=${this.value}
					@input=${this.handleTextareaInput}
					@keydown=${this.handleKeyDown}
					@paste=${this.handlePaste}
					${ref(this.textareaRef)}
				></textarea>

				<!-- Hidden file input -->
				<input
					type="file"
					${ref(this.fileInputRef)}
					@change=${this.handleFilesSelected}
					accept=${this.acceptedTypes}
					multiple
					style="display: none;"
				/>

				<!-- Button Row -->
				<div class="px-2 pb-2 flex items-center justify-between">
					<!-- Left side - attachment and thinking selector -->
					<div class="flex gap-2 items-center">
						${
							this.showAttachmentButton
								? this.processingFiles
									? html`
										<div class="h-8 w-8 flex items-center justify-center">
											${icon(Loader2, "sm", "animate-spin text-muted-foreground")}
										</div>
									`
									: html`
										<span title="Attach a document — PDF, Office files, images or plain text">
											${Button({
												variant: "ghost",
												size: "icon",
												className: "h-8 w-8",
												onClick: this.handleAttachmentClick,
												children: icon(Paperclip, "sm"),
											})}
										</span>
									`
								: ""
						}
						${
							supportsThinking && this.showThinkingSelector
								? html`
									${Select({
										value: this.thinkingLevel,
										placeholder: i18n("Off"),
										options: [
											{ value: "off", label: i18n("Off"), icon: icon(Brain, "sm") },
											{ value: "minimal", label: i18n("Minimal"), icon: icon(Brain, "sm") },
											{ value: "low", label: i18n("Low"), icon: icon(Brain, "sm") },
											{ value: "medium", label: i18n("Medium"), icon: icon(Brain, "sm") },
											{ value: "high", label: i18n("High"), icon: icon(Brain, "sm") },
										] as SelectOption[],
										onChange: (value: string) => {
											const level = value as "off" | "minimal" | "low" | "medium" | "high";
											this.thinkingLevel = level;
											this.onThinkingChange?.(level);
										},
										width: "80px",
										size: "sm",
										variant: "ghost",
										fitContent: true,
									})}
								`
								: ""
						}
					</div>

					<!-- Model selector and send on the right -->
					<div class="flex gap-2 items-center">
						${
							this.showModelSelector && this.currentModel
								? html`
									${Button({
										variant: "ghost",
										size: "sm",
										onClick: () => {
											// Focus textarea before opening model selector so focus returns there
											this.textareaRef.value?.focus();
											// Wait for next frame to ensure focus takes effect before dialog captures it
											requestAnimationFrame(() => {
												this.onModelSelect?.();
											});
										},
										children: html`
											${icon(Sparkles, "sm")}
											<span class="ml-1">${this.currentModel.id}</span>
										`,
										className: "h-8 text-xs truncate",
									})}
								`
								: ""
						}
						<span data-editor-controls style="display: contents"></span>
						${
							this.isStreaming
								? html`
									${Button({
										variant: "ghost",
										size: "icon",
										onClick: this.onAbort,
										title: "Stop response",
										children: icon(Square, "sm"),
										className: "h-8 w-8 cw-stop-response",
									})}
								`
								: html`
									${Button({
										variant: "ghost",
										size: "icon",
										onClick: this.handleSend,
										disabled: this.disabled || (!this.value.trim() && this.attachments.length === 0) || this.processingFiles,
										children: html`<div style="transform: rotate(-45deg)">${icon(Send, "sm")}</div>`,
										className: "h-8 w-8",
									})}
								`
						}
					</div>
				</div>
			</div>
		`;
	}
}
