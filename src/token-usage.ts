/** Unknown usage cannot establish a resource budget or a monetary/token total. */
export function validatedTokenUsage(value: unknown, format: "pi" | "openai" = "pi", requireOutput = false): { input: number; output: number } {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Completion token usage is unavailable");
  const row = value as Record<string, unknown>;
  const input = row[format === "pi" ? "input" : "prompt_tokens"];
  const output = row[format === "pi" ? "output" : "completion_tokens"];
  if (typeof input !== "number" || typeof output !== "number" || !Number.isSafeInteger(input) || !Number.isSafeInteger(output) || input < 0 || output < 0 || (requireOutput && output === 0)) throw new Error("Completion token usage is invalid or missing for generated content");
  return { input, output };
}
export function addTokenUsage(total: {input:number;output:number}, next: {input:number;output:number}): void {
  const input = total.input + next.input, output = total.output + next.output;
  if (!Number.isSafeInteger(input) || !Number.isSafeInteger(output)) throw new Error("Completion token usage overflow");
  total.input = input; total.output = output;
}
