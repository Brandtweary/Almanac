import { AdmissionError } from "./queue";
/** The pinned vLLM chat and tokenize APIs use the same renderer with different request schemas. */
export function vllmTokenizePayload(body: Record<string, unknown>, excludeToolsWhenNone = false): Record<string, unknown> {
  if (body.tool_choice !== undefined && !["auto", "none"].includes(body.tool_choice as string)) throw new AdmissionError("tokenizer_tool_choice_unsupported", 400);
  if (body.response_format !== undefined) throw new AdmissionError("tokenizer_response_format_unsupported", 400);
  const kwargs = body.chat_template_kwargs;
  if (kwargs !== undefined && (!kwargs || typeof kwargs !== "object" || Array.isArray(kwargs))) throw new AdmissionError("invalid_template_options", 400);
  const extra: Record<string, unknown> = {documents: body.documents ?? null, reasoning_effort: body.reasoning_effort ?? null};
  if (body.reasoning_effort !== undefined && !("enable_thinking" in (kwargs as object ?? {}))) extra.enable_thinking = body.reasoning_effort !== "none";
  const merged = {...kwargs as object, ...Object.fromEntries(Object.entries(extra).filter(([, value]) => value !== null && value !== "auto"))};
  // Chat completion normalizes this deprecated field before rendering;
  // the native tokenize request does not apply that protocol validator.
  const messages = Array.isArray(body.messages) ? body.messages.map(message => {
    if (!message || typeof message !== "object" || Array.isArray(message)) return message;
    const {reasoning_content, ...normalized} = message as Record<string, unknown>;
    if (reasoning_content != null && normalized.reasoning == null) normalized.reasoning = reasoning_content;
    return normalized;
  }) : body.messages;
  return {
    model: body.model, messages,
    tools: body.tool_choice === "none" && excludeToolsWhenNone ? undefined : body.tools,
    add_generation_prompt: body.add_generation_prompt ?? true,
    continue_final_message: body.continue_final_message ?? false,
    add_special_tokens: body.add_special_tokens ?? false,
    chat_template: body.chat_template,
    chat_template_kwargs: merged,
    media_io_kwargs: body.media_io_kwargs, mm_processor_kwargs: body.mm_processor_kwargs,
  };
}
