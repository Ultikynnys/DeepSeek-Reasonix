/** Built-in model catalog and capability predicates shared by the daemon and desktop UI. */

/** Models accepted by the official DeepSeek endpoint. */
export const SUPPORTED_OFFICIAL_MODELS: readonly string[] = [
  "deepseek-v4-flash",
  "deepseek-v4-pro",
  "deepseek-v4-flash-vision-exp",
];

/** GPT-5.6 models accepted by the OpenAI endpoint. The bare `gpt-5.6` alias
 *  is intentionally absent — it was retired; stale configs clamp to the default
 *  model (see tests/config.test.ts "stale configs clamp"). */
export const GPT56_MODELS: readonly string[] = [
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
];

/** Models accepted by Z.AI's general API endpoint. */
export const ZAI_MODELS: readonly string[] = [
  "glm-5.3-flash",
  "glm-5.3",
  "glm-5.2",
  "glm-5.1",
  "glm-5",
  "glm-4.7",
  "glm-4.7-flash",
  "glm-4.7-flashx",
  "glm-4.6",
  "glm-4.6v",
  "glm-4.6v-flash",
  "glm-4.6v-flashx",
  "glm-4.5",
  "glm-4.5-air",
  "glm-4.5-x",
  "glm-4.5-airx",
  "glm-4.5-flash",
  "glm-4.5v",
  "glm-4-32b-0414-128k",
];

/** Unified models served through Google Antigravity OAuth and Cloud Code. */
export const ANTIGRAVITY_MODELS: readonly string[] = [
  "gemini-3.6-flash",
  "gemini-3.7-flash",
  "gemini-3.7-flash-tiered",
  "gemini-3.8-flash",
  "gemini-3.8-flash-tiered",
  "claude-sonnet-4-6-thinking",
  "claude-opus-4-6-thinking",
  "gpt-oss-120b-medium",
];

/** Compatibility export for existing consumers. */
export const GEMINI_MODELS = ANTIGRAVITY_MODELS;

/** Drops unusable Antigravity ids: internal chat/tab routing ids, duplicate
 *  vertex buckets, and legacy Gemini models between 2.0 and 3.1 inclusive. */
export function isUsableAntigravityModel(modelId: string | undefined | null): boolean {
  if (typeof modelId !== "string") return false;
  const trimmed = modelId.trim();
  if (!trimmed) return false;
  if (trimmed.endsWith("_vertex")) return false;
  if (trimmed.startsWith("chat_") || trimmed.startsWith("tab_")) return false;

  const geminiMatch = trimmed.match(/^gemini-(\d+)(?:\.(\d+))?/i);
  if (geminiMatch) {
    const major = Number.parseInt(geminiMatch[1]!, 10);
    const minor = geminiMatch[2] !== undefined ? Number.parseInt(geminiMatch[2], 10) : 0;
    // Filter legacy models between 2.0 and 3.1 (2.x and 3.0/3.1)
    if (major === 2 || (major === 3 && minor <= 1)) {
      return false;
    }
  }

  return true;
}

export function isAntigravityModel(model: string | undefined | null): boolean {
  return (
    typeof model === "string" &&
    isUsableAntigravityModel(model) &&
    (model.startsWith("gemini-") ||
      model.startsWith("claude-") ||
      model.startsWith("gpt-oss-"))
  );
}

/** Model ids offered by the default endpoints and desktop model pickers. */
export const KNOWN_MODELS: readonly string[] = [
  ...SUPPORTED_OFFICIAL_MODELS,
  ...GPT56_MODELS,
  ...ZAI_MODELS,
  ...ANTIGRAVITY_MODELS,
];

/** Friendly display labels for ambiguous or internal model IDs. */
export const MODEL_DISPLAY_NAMES: Readonly<Record<string, string>> = {
  "gemini-pro-agent": "gemini-3.5-pro",
};

/** Returns the display label for a model id, applying friendly UI mappings. */
export function modelDisplayName(model: string | undefined | null): string {
  if (!model) return "";
  return MODEL_DISPLAY_NAMES[model] ?? model;
}

/** Model ids that accept image attachments in user messages — the GPT-5.6
 *  family, DeepSeek's vision line, and every Gemini model (natively
 *  multimodal). Drives the composer's paste/drop affordance, the daemon's
 *  @-mention conversion, and the images hard gate.
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
  if (model === "glm-5.3-flash" || /^glm-\d+(?:\.\d+)?v(?:-|$)/.test(model)) return true;
  if (isAntigravityModel(model)) return true;
  if (model.startsWith("ollama/") && ollamaVision && ollamaVision.has(model)) return true;
  return false;
}
