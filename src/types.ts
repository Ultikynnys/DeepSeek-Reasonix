export interface JSONSchema {
  type?: string;
  properties?: Record<string, JSONSchema>;
  items?: JSONSchema;
  required?: string[];
  description?: string;
  enum?: unknown[];
  [k: string]: unknown;
}

export interface ToolFunctionSpec {
  name: string;
  description: string;
  parameters: JSONSchema;
}

export interface ToolSpec {
  type: "function";
  function: ToolFunctionSpec;
}

export interface ToolCall {
  id?: string;
  type?: "function";
  function: {
    name: string;
    arguments: string;
  };
  /** Gemini 3.x: a function call's thoughtSignature must be echoed back
   *  unchanged in the next request or the tool-loop continuation 400s. Set by
   *  the Gemini provider; ignored by other providers. */
  thoughtSignature?: string;
}

/** OpenAI multimodal content part — ChatGPT-family models accept these in
 *  user messages; DeepSeek models reject them (400), so image parts are
 *  gated off for non-OpenAI providers before they reach the client. */
export type UserContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string; detail?: "low" | "high" | "auto" } }
  /** Model-generated image (e.g. Antigravity's inlineData part) — output-side,
   *  carried on assistant messages so history/reload/compaction preserve it. */
  | { type: "image"; data_url: string; mime_type: string };

export type Role = "system" | "user" | "assistant" | "tool";

/** A normalized image attached to a user turn — data URL for the vision API,
 *  plus the original file path when available, so the agent can open/modify
 *  the source with its file tools instead of only seeing the pixels. */
export interface TurnImage {
  url: string;
  path?: string;
}

export interface ChatMessage {
  role: Role;
  content?: string | UserContentPart[] | null;
  name?: string;
  tool_call_id?: string;
  tool_calls?: ToolCall[];
  /** Must round-trip in tool-loop continuations — thinking mode 400s without it. */
  reasoning_content?: string | null;
}

export interface RawUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  prompt_cache_hit_tokens?: number;
  prompt_cache_miss_tokens?: number;
  /** Ollama native API: input tokens processed. */
  prompt_eval_count?: number;
  /** Ollama native API: output tokens generated. */
  eval_count?: number;
  /** Ollama native API: prompt evaluation time, nanoseconds. */
  prompt_eval_duration?: number;
  /** Ollama native API: output generation time, nanoseconds. */
  eval_duration?: number;
  /** Ollama native API: model load time, nanoseconds. */
  load_duration?: number;
  /** OpenAI Responses API usage names (codex backend / /v1/responses). */
  input_tokens?: number;
  output_tokens?: number;
  input_tokens_details?: { cached_tokens?: number };
  /** Google Antigravity / Gemini usageMetadata names. */
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  totalTokenCount?: number;
  cachedContentTokenCount?: number;
  cached_content_token_count?: number;
}

export interface ChatRequestOptions {
  model: string;
  messages: ChatMessage[];
  tools?: readonly ToolSpec[];
  temperature?: number;
  maxTokens?: number;
  stream?: boolean;
  signal?: AbortSignal;
  /** DeepSeek response_format — use { type: "json_object" } to force valid JSON. */
  responseFormat?: { type: "json_object" | "text" };
  thinking?: "enabled" | "disabled";
  reasoningEffort?: import("./config.js").ReasoningEffort;
  /** Ollama native `/api/chat` extras — the OpenAI-compat layer silently drops
   *  both fields, so they only reach the server through the native transport. */
  ollama?: {
    /** Server-side context window (`num_ctx`). Unset → config/env, then learned. */
    numCtx?: number;
    /** Model residency after the turn. Unset → config/env, then "30m". */
    keepAlive?: string;
    /** Nucleus sampling probability (`top_p`). */
    topP?: number;
    /** Minimum probability relative to the most likely token (`min_p`). */
    minP?: number;
    /** Deterministic sampling seed. */
    seed?: number;
    /** Repeat penalty (`repeat_penalty`). Higher values penalize repetition more
     *  aggressively. Unset → config/env, then server default (1.1). */
    repeatPenalty?: number;
    /** Frequency penalty (`frequency_penalty`). Penalizes tokens proportional to
     *  how often they appeared. Unset → config/env, then server default (0). */
    frequencyPenalty?: number;
    /** Presence penalty (`presence_penalty`). Penalizes tokens that appeared at
     *  all (binary). Unset → config/env, then server default (0). */
    presencePenalty?: number;
    /** Top-K sampling (`top_k`). Limits the candidate pool. Unset → config/env,
     *  then server default (40). */
    topK?: number;
    /** Repeat penalty lookback window (`repeat_last_n`). How many tokens back
     *  to consider. Unset → config/env, then server default (64). */
    repeatLastN?: number;
  };
}
