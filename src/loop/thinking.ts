/** True when the model emits reasoning_content and requires it round-tripped on follow-ups. */
export function isThinkingModeModel(model: string): boolean {
  if (model.startsWith("gpt-")) return false;
  if (model.includes("reasoner")) return true;
  if (model.startsWith("glm-")) return true;
  // DeepSeek v4 models (official API or Ollama-hosted like ollama/deepseek-v4-flash:0731)
  if (model.includes("deepseek-v4-flash") || model.includes("deepseek-v4-pro")) return true;
  // Ollama DeepSeek R1 models (e.g. ollama/deepseek-r1:14b, deepseek-r1:7b)
  if (model.includes("deepseek-r1")) return true;
  return false;
}

/** Pins extra_body.thinking.type; `undefined` lets third-party endpoints skip the field. */
export function thinkingModeForModel(model: string): "enabled" | "disabled" | undefined {
  if (model.startsWith("gpt-")) return undefined;
  if (model === "deepseek-chat") return "disabled";
  if (model.startsWith("glm-")) return "enabled";
  if (model.includes("reasoner")) return "enabled";
  // DeepSeek v4 models (official API or Ollama-hosted like ollama/deepseek-v4-flash:0731)
  if (model.includes("deepseek-v4-flash") || model.includes("deepseek-v4-pro")) return "enabled";
  // Ollama DeepSeek R1 models (e.g. ollama/deepseek-r1:14b, deepseek-r1:8b)
  if (model.includes("deepseek-r1")) return "enabled";
  return undefined;
}

/** Strip hallucinated tool-call envelopes — `tools: undefined` doesn't always force prose. */
export function stripHallucinatedToolMarkup(s: string): string {
  let out = s;
  // DeepSeek's DSML envelope (full-width "｜" is the form R1 emits in practice).
  out = out.replace(
    /<[｜|]DSML[｜|]function_calls>[\s\S]*?<\/?(?:[｜|]DSML[｜|]function_calls)?>/g,
    "",
  );
  out = out.replace(/<function_calls>[\s\S]*?<\/function_calls>/g, "");
  // Loose DSML invoke blocks without wrapping function_calls.
  out = out.replace(/<[｜|]DSML[｜|]invoke\s+[^>]*>[\s\S]*?<\/[｜|]DSML[｜|]invoke>/g, "");
  // Lone unpaired DSML opener left over after R1 truncates mid-call.
  out = out.replace(/<[｜|]DSML[｜|][\s\S]*$/g, "");
  return out.trim();
}

/** Extract literal thinking tags (`<think>...</think>`) from content if the model
 *  emitted reasoning directly into the content stream instead of the thinking channel.
 *  Returns the cleaned content and any extracted reasoning text. */
export function extractThinkingTags(content: string): {
  content: string;
  extractedReasoning: string | null;
} {
  const THINK_BLOCK_RE = /<think>([\s\S]*?)<\/think>/gi;
  const thoughts: string[] = [];
  let cleaned = content.replace(THINK_BLOCK_RE, (_, thought: string) => {
    const trimmed = thought.trim();
    if (trimmed) thoughts.push(trimmed);
    return "";
  });

  // Handle open-ended/truncated <think> at the end of content
  const UNCLOSED_THINK_RE = /<think>([\s\S]*)$/i;
  const unclosed = UNCLOSED_THINK_RE.exec(cleaned);
  if (unclosed) {
    const trimmed = unclosed[1]?.trim();
    if (trimmed) thoughts.push(trimmed);
    cleaned = cleaned.replace(UNCLOSED_THINK_RE, "");
  }

  // Also strip stray orphaned closing </think> tags
  cleaned = cleaned.replace(/<\/think>/gi, "");

  const extractedReasoning = thoughts.length > 0 ? thoughts.join("\n\n") : null;
  return {
    content: cleaned.trim(),
    extractedReasoning,
  };
}
