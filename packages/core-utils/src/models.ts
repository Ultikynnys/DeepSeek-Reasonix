/** Model capability predicates — shared by the daemon (src/) and the desktop
 *  UI so the two sides can't drift on which model ids accept images. */

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
