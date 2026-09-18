import { AdmissionError } from "./queue";

/** Request fields a client may set. Everything else is dropped before admission
 *  counting and before the backend sees the body.
 *
 *  Both pinned backends accept far more than this: the vLLM OpenAI server declares
 *  `extra="allow"` and honours `n`, `min_tokens`, `ignore_eos`, `prompt_logprobs`,
 *  `logit_bias`, `chat_template` and `chat_template_kwargs`, several of which
 *  multiply or extend generation past the role budget this gateway advertises,
 *  or replace the release profile's pinned chat template. An allow-list is the
 *  defensible shape here because the browser client's payload is a closed set:
 *  anything outside it did not come from the application.
 *
 *  `max_completion_tokens` is admitted only so the caller can normalize it onto
 *  `max_tokens`; `store` is sent by the client's provider library and ignored by
 *  both pinned backends. Sampling is not client policy — the release profile
 *  overwrites `temperature`/`top_p`/`top_k` after this filter runs. */
export const CLIENT_COMPLETION_FIELDS = ["model", "messages", "stream", "stream_options", "store",
  "max_tokens", "max_completion_tokens", "temperature", "top_p", "top_k", "tools", "tool_choice",
  "reasoning_effort"] as const;

export function pinnedCompletionBody(body: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(CLIENT_COMPLETION_FIELDS
    .filter(field => body[field] !== undefined)
    .map(field => [field, body[field]]));
}

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
