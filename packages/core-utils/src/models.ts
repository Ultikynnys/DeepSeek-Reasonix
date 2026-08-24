/** Built-in model catalog and capability predicates shared by the daemon and desktop UI. */

/** Models accepted by the official DeepSeek endpoint. */
export const SUPPORTED_OFFICIAL_MODELS: readonly string[] = [
  "deepseek-v4-flash",
  "deepseek-v4-pro",
  "deepseek-v4-flash-vision-exp",
];

/** GPT-5.6 models accepted by the OpenAI endpoint. */
export const GPT56_MODELS: readonly string[] = [
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
];

/** Gemini models served through Google Antigravity OAuth and Cloud Code. */
export const GEMINI_MODELS: readonly string[] = [
  "gemini-2.5-flash",
  "gemini-2.5-pro",
  "gemini-3.6-flash",
  "gemini-3.7-flash",
];

/** Model ids offered by the default endpoints and desktop model pickers. */
export const KNOWN_MODELS: readonly string[] = [
  ...SUPPORTED_OFFICIAL_MODELS,
  ...GPT56_MODELS,
  ...GEMINI_MODELS,
];

/** Model ids that accept image attachments in user messages — the GPT-5.6
 *  family plus DeepSeek's vision line. Drives the composer's paste/drop
 *  affordance, the daemon's @-mention conversion, and the images hard gate.
 *
 *  `ollamaVision` is the set of `ollama/`-prefixed ids confirmed vision-capable
 *  by runtime probing (see the daemon's `$ollama_models.visionModels`). When
 *  provided, an Ollama model in that set accepts images; when omitted, all
 *  Ollama models are treated as non-vision (conservative default). Non-Ollama
 *  ids are unaffected by this argument. */
export function modelAcceptsImages(
  model: string | undefined | null,
  ollamaVision?: ReadonlySet<string> | null,
): boolean {
  if (typeof model !== "string") return false;
  if (model.startsWith("gpt-")) return true;
  if (model === "deepseek-v4-flash-vision-exp") return true;
  if (model.startsWith("ollama/") && ollamaVision && ollamaVision.has(model)) return true;
  return false;
}
