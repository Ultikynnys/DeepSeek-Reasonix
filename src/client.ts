import { type EventSourceMessage, createParser } from "eventsource-parser";
import { ANTIGRAVITY_CLOUD_CODE_URL, antigravityHeaders } from "./antigravity-oauth.js";
import {
  deriveNativeOllamaOrigin,
  loadOllamaKeepAlive,
  loadOllamaNumCtx,
  loadRateLimit,
  providerForModel,
  resolveBaseUrlEnv,
} from "./config.js";
import { createLogger } from "./logging.js";
import { showPayloadContextLength } from "./ollama-model-map.js";
import { buildResponsesPayload } from "./responses-api.js";
import { type RetryOptions, fetchWithRetry } from "./retry.js";
import { estimateRequestTokens } from "./tokenizer.js";
import type { ChatMessage, ChatRequestOptions, RawUsage, ToolCall, ToolSpec } from "./types.js";

const log = createLogger("client");

/** How long a learned Ollama context window is trusted before re-probing
 *  `/api/show` (model registry changes are rare; 10 min keeps it fresh). */
const OLLAMA_SHOW_PROBE_TTL_MS = 10 * 60_000;

export class Usage {
  constructor(
    public promptTokens = 0,
    public completionTokens = 0,
    public totalTokens = 0,
    public promptCacheHitTokens = 0,
    public promptCacheMissTokens = 0,
    public promptEvalDurationMs = 0,
    public evalDurationMs = 0,
    public loadDurationMs = 0,
  ) {}

  get cacheHitRatio(): number {
    const denom = this.promptCacheHitTokens + this.promptCacheMissTokens;
    return denom > 0 ? this.promptCacheHitTokens / denom : 0;
  }

  static hasApiUsage(raw: unknown): raw is RawUsage {
    if (!raw || typeof raw !== "object") return false;
    const u = raw as RawUsage;
    return (
      typeof u.prompt_tokens === "number" ||
      typeof u.completion_tokens === "number" ||
      typeof u.total_tokens === "number" ||
      typeof u.prompt_cache_hit_tokens === "number" ||
      typeof u.prompt_cache_miss_tokens === "number" ||
      typeof u.prompt_eval_count === "number" ||
      typeof u.eval_count === "number" ||
      // OpenAI Responses API usage names (codex backend / /v1/responses).
      typeof u.input_tokens === "number" ||
      typeof u.output_tokens === "number"
    );
  }

  static fromApi(raw: RawUsage | undefined | null): Usage {
    const u = raw ?? {};
    const promptTokens = u.prompt_tokens ?? u.prompt_eval_count ?? u.input_tokens ?? 0;
    const completionTokens = u.completion_tokens ?? u.eval_count ?? u.output_tokens ?? 0;
    const cacheHitTokens = u.prompt_cache_hit_tokens ?? u.input_tokens_details?.cached_tokens ?? 0;
    const cacheMissTokens =
      u.prompt_cache_miss_tokens ?? Math.max(0, promptTokens - cacheHitTokens);
    return new Usage(
      promptTokens,
      completionTokens,
      u.total_tokens ?? promptTokens + completionTokens,
      cacheHitTokens,
      cacheMissTokens,
      nsToMs(u.prompt_eval_duration),
      nsToMs(u.eval_duration),
      nsToMs(u.load_duration),
    );
  }
}

/** Ollama native metrics report durations in nanoseconds — normalize to ms. */
function nsToMs(ns: number | undefined): number {
  return typeof ns === "number" && Number.isFinite(ns) ? Math.round(ns / 1_000_000) : 0;
}
/** Convert a ChatMessage to Ollama's native message shape: content parts split
 *  into text + `images` (data-URI base64 stripped), tool-call arguments parsed
 *  from JSON strings into objects, reasoning round-tripped as `thinking`. */
function toNativeOllamaMessage(msg: ChatMessage): Record<string, unknown> {
  const out: Record<string, unknown> = { role: msg.role };
  if (msg.name) out.tool_name = msg.name;
  if (msg.tool_call_id) out.tool_call_id = msg.tool_call_id;
  if (msg.reasoning_content) out.thinking = msg.reasoning_content;
  if (Array.isArray(msg.content)) {
    const text: string[] = [];
    const images: string[] = [];
    for (const part of msg.content) {
      if (part.type === "text") {
        text.push(part.text);
      } else if (part.type === "image_url") {
        // Native messages carry raw base64 bytes, not data URIs — strip the
        // `data:image/...;base64,` prefix if present.
        const url = part.image_url.url;
        const comma = url.indexOf(",");
        images.push(comma >= 0 ? url.slice(comma + 1) : url);
      }
    }
    if (text.length > 0) out.content = text.join("\n");
    if (images.length > 0) out.images = images;
  } else if (typeof msg.content === "string") {
    out.content = msg.content;
  }
  if (msg.tool_calls?.length) {
    out.tool_calls = msg.tool_calls.map((tc) => ({
      function: {
        name: tc.function?.name ?? "",
        arguments: parseToolCallArguments(tc.function?.arguments),
      },
    }));
  }
  return out;
}

/** Native tool-call arguments are objects, not JSON strings — parse, and treat
 *  malformed input as an empty object rather than dropping the call. */
function parseToolCallArguments(raw: string | undefined): unknown {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/** The inverse — native responses hand tool-call arguments back as objects;
 *  the loop consumes them as JSON strings. */
function stringifyNativeToolCallArguments(args: unknown): string {
  if (typeof args === "string") return args;
  try {
    return JSON.stringify(args ?? {});
  } catch {
    return "{}";
  }
}

/** Plain text of a message, joining text parts — used for the Cloud Code
 *  systemInstruction and tool responses. */
function messageText(msg: ChatMessage): string {
  if (typeof msg.content === "string") return msg.content;
  if (Array.isArray(msg.content)) {
    return msg.content
      .filter((p) => p.type === "text")
      .map((p) => (p as { text: string }).text)
      .join("\n");
  }
  return "";
}

/** Split a `data:image/png;base64,...` URL into mimeType + base64 data. */
function parseDataUrl(url: string): { mimeType: string; data: string } {
  const comma = url.indexOf(",");
  if (comma >= 0) {
    const mime = /data:([^;]+)/.exec(url.slice(0, comma))?.[1] ?? "application/octet-stream";
    return { mimeType: mime, data: url.slice(comma + 1) };
  }
  return { mimeType: "application/octet-stream", data: url };
}

/** Tool result body for a Cloud Code functionResponse, whose response must be a JSON object. */
function toolResultContent(content: ChatMessage["content"]): Record<string, unknown> {
  const result =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content
            .filter((part) => part.type === "text")
            .map((part) => (part as { text: string }).text)
            .join("\n")
        : "";
  return { result };
}

/** JSON-Schema keywords Gemini's OpenAPI-3.0 function-declaration subset
 *  rejects. Bridged MCP schemas routinely carry these; forwarding them can
 *  trigger a 400 INVALID_ARGUMENT, so they are stripped before upload. */
const GEMINI_UNSUPPORTED_SCHEMA_KEYS = new Set([
  "$schema",
  "$ref",
  "$defs",
  "definitions",
  "additionalProperties",
  "patternProperties",
  "anyOf",
  "oneOf",
  "allOf",
  "not",
]);

/** Recursively whitelist a tool `parameters` schema to the Gemini-safe subset,
 *  preserving nesting structure while dropping unsupported keywords. */
function sanitizeGeminiSchema(params: unknown): unknown {
  if (!params || typeof params !== "object") return params;
  if (Array.isArray(params)) return params;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(params as Record<string, unknown>)) {
    if (GEMINI_UNSUPPORTED_SCHEMA_KEYS.has(key)) continue;
    if (key === "properties" && value && typeof value === "object") {
      const props: Record<string, unknown> = {};
      for (const [pk, pv] of Object.entries(value as Record<string, unknown>)) {
        props[pk] = sanitizeGeminiSchema(pv);
      }
      out.properties = props;
      continue;
    }
    if (key === "items" && value && typeof value === "object") {
      out.items = sanitizeGeminiSchema(value);
      continue;
    }
    out[key] = value;
  }
  return out;
}

/** Byte-stable equality for the cache-prefix overlap check — key order is
 *  deterministic because both sides serialize the same source objects. */
function sameMessage(a: ChatMessage, b: ChatMessage): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Map reasoningEffort / thinking to Ollama's `think` field — mirrors Ollama's
 *  own thinkFromReasoningEffort ladder (none→false, minimal→low, xhigh/ultra→max). */
function ollamaThinkValue(opts: ChatRequestOptions): boolean | string | undefined {
  if (opts.thinking === "enabled") return true;
  if (opts.thinking === "disabled") return false;
  switch (opts.reasoningEffort) {
    case "low":
    case "medium":
    case "high":
      return opts.reasoningEffort;
    case "xhigh":
    case "max":
      return "max";
    default:
      return undefined;
  }
}

export interface ChatResponse {
  content: string;
  reasoningContent: string | null;
  toolCalls: ToolCall[];
  usage: Usage;
  raw: unknown;
  /** Model-generated image (Antigravity inlineData part) — data URL + mime. */
  image?: { dataUrl: string; mimeType: string };
}

export interface StreamChunk {
  contentDelta?: string;
  reasoningDelta?: string;
  toolCallDelta?: {
    index: number;
    id?: string;
    name?: string;
    argumentsDelta?: string;
    /** Gemini 3.x function-call thought signature, forwarded verbatim. */
    thoughtSignature?: string;
  };
  usage?: Usage;
  finishReason?: string;
  /** Model-generated image (Antigravity inlineData part) — data URL + mime. */
  image?: { dataUrl: string; mimeType: string };
  raw: any;
}

export interface BalanceInfo {
  currency: string;
  total_balance: string;
  granted_balance?: string;
  topped_up_balance?: string;
}

export interface UserBalance {
  is_available: boolean;
  balance_infos: BalanceInfo[];
}

/** Largest `total_balance` wins — the wallet the user actually paid for and expects to see ticking down. */
export function pickPrimaryBalance(infos: ReadonlyArray<BalanceInfo>): BalanceInfo | null {
  if (infos.length === 0) return null;
  let best = infos[0]!;
  for (let i = 1; i < infos.length; i++) {
    if (Number(infos[i]!.total_balance) > Number(best.total_balance)) best = infos[i]!;
  }
  return best;
}

export interface ModelInfo {
  id: string;
  object: "model";
  owned_by: string;
}

export interface ModelList {
  object: "list";
  data: ModelInfo[];
}

export interface ResolvedTransport {
  /** Full URL to POST to (replaces `${baseUrl}/chat/completions`). */
  endpoint: string;
  /** Headers to merge on top of the defaults — Authorization is replaced. */
  headers: Record<string, string>;
  /** When "responses", the endpoint speaks the OpenAI Responses API (e.g. the
   *  ChatGPT Codex backend) — payloads use `input` instead of `messages` and
   *  responses parse from the `output` array / Responses SSE events. */
  api?: "responses";
}

export interface DeepSeekClientOptions {
  apiKey?: string;
  baseUrl?: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
  rateLimit?: { rpm?: number };
  /** Retry configuration. Pass `{ maxAttempts: 1 }` to disable retries. */
  retry?: RetryOptions;
  /** Per-request key resolution — lets OpenAI OAuth tokens refresh mid-session.
   *  When it returns a value it wins over `apiKey`; when it returns undefined
   *  the static key (or the constructor's env fallback) is used. */
  apiKeyResolver?: () => Promise<string | undefined>;
  /** Per-request transport override for plan-quota billing via Codex backend. */
  transportResolver?: () => Promise<ResolvedTransport | null>;
  /** Per-request auth for gemini-* models (Antigravity quota): the Google OAuth
   *  access token plus the Cloud Code companion project id. Returns null when
   *  the user isn't signed in — gemini requests then fail with a clear error. */
  geminiAuthResolver?: () => Promise<{ accessToken: string; projectId?: string } | null>;
  /** Skip the "No API key" constructor throw — for keyless endpoints like the
   *  local Ollama daemon, where the Authorization header is simply omitted. */
  allowMissingKey?: boolean;
}

// DeepSeek's strict JSON parser rejects lone UTF-16 surrogate escapes
// (`\ud800`, `\udc00`) even though JavaScript can carry them in strings.
function replaceLoneSurrogates(value: string): string {
  let out = "";
  let last = 0;
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        i++;
      } else {
        out += value.slice(last, i);
        out += "\uFFFD";
        last = i + 1;
      }
      continue;
    }
    if (code >= 0xdc00 && code <= 0xdfff) {
      out += value.slice(last, i);
      out += "\uFFFD";
      last = i + 1;
    }
  }
  if (last === 0) return value;
  return out + value.slice(last);
}

function sanitizeJsonTransportValue(value: unknown): unknown {
  if (typeof value === "string") return replaceLoneSurrogates(value);
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => sanitizeJsonTransportValue(item));
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    out[key] = sanitizeJsonTransportValue(item);
  }
  return out;
}

function stringifyJsonTransport(value: unknown): string {
  return JSON.stringify(sanitizeJsonTransportValue(value));
}

export class DeepSeekClient {
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly timeoutMs: number;
  readonly retry: RetryOptions;
  private readonly _fetch: typeof fetch;
  private readonly minChatIntervalMs: number;
  private readonly apiKeyResolver?: () => Promise<string | undefined>;
  private readonly transportResolver?: () => Promise<ResolvedTransport | null>;
  private readonly geminiAuthResolver?: () => Promise<{
    accessToken: string;
    projectId?: string;
  } | null>;
  private nextChatRequestAt = 0;

  /** What was last sent per Ollama model, for cache-prefix inference. */
  private readonly ollamaLastSent = new Map<
    string,
    { messages: readonly ChatMessage[]; toolsKey: string }
  >();

  /** Learned context windows per Ollama model (from `/api/show`), with timestamps. */
  private readonly ollamaContextCache = new Map<string, { at: number; contextTokens?: number }>();

  constructor(opts: DeepSeekClientOptions = {}) {
    // Keyless endpoints (local Ollama) must NOT fall back to the
    // DEEPSEEK_API_KEY env — that would ship the DeepSeek key to whatever the
    // baseUrl points at (a cloud Ollama endpoint could capture it).
    const apiKey = opts.apiKey ?? (opts.allowMissingKey ? undefined : process.env.DEEPSEEK_API_KEY);
    if (!apiKey && !opts.apiKeyResolver && !opts.transportResolver && !opts.allowMissingKey) {
      throw new Error(
        "No API key: set DEEPSEEK_API_KEY (deepseek-* models) or OPENAI_API_KEY (gpt-* models) in .env, or pass apiKey to DeepSeekClient.",
      );
    }
    this.apiKey = apiKey ?? "";
    this.apiKeyResolver = opts.apiKeyResolver;
    this.transportResolver = opts.transportResolver;
    this.geminiAuthResolver = opts.geminiAuthResolver;
    let url = opts.baseUrl ?? resolveBaseUrlEnv() ?? "https://api.deepseek.com";
    // Manual trim — `/\/+$/` is O(n²) on slash-heavy non-matches per CodeQL js/polynomial-redos.
    while (url.endsWith("/")) url = url.slice(0, -1);
    this.baseUrl = url;
    // 11 min. DeepSeek's load-balancer may keep a connection open for
    // up to 10 minutes while the request waits in queue (non-streaming
    // sends empty lines, streaming sends `:` SSE keep-alive comments —
    // both are invisible to our parsers, so neither surfaces until the
    // real response starts). Timing out at the legacy 2-min default
    // killed queued requests prematurely, burned the queue slot on
    // retry, and could loop through the whole queue repeatedly.
    // Setting 11 min lets the server's own 10-min cap close the
    // connection first (clean EOF → natural retry), and our timer
    // is a safety net for genuinely hung sockets.
    this.timeoutMs = opts.timeoutMs ?? 660_000;
    this._fetch = opts.fetch ?? globalThis.fetch.bind(globalThis);
    this.retry = opts.retry ?? {};
    const rpm = opts.rateLimit?.rpm ?? loadRateLimit()?.rpm;
    this.minChatIntervalMs = rpm ? Math.ceil(60_000 / rpm) : 0;
  }

  /** Resolved per request — OAuth access tokens expire far faster than static keys. */
  private async resolveApiKey(): Promise<string> {
    if (this.apiKeyResolver) {
      const resolved = await this.apiKeyResolver();
      if (resolved) return resolved;
    }
    return this.apiKey;
  }

  /** Resolved per request — transport override or null (falls through to baseUrl+apiKey). */
  private async resolveTransport(): Promise<ResolvedTransport | null> {
    if (!this.transportResolver) return null;
    return this.transportResolver();
  }

  /** Authorization header when a key exists — omitted entirely for keyless
   *  endpoints (Ollama's local daemon ignores auth, so `Bearer ` would be noise). */
  private async authHeaders(): Promise<Record<string, string>> {
    const key = await this.resolveApiKey();
    return key ? { Authorization: `Bearer ${key}` } : {};
  }

  /** Timer + combined-signal pair for one request — the caller clears the
   *  timer in its finally. Combining keeps timeoutMs reaching fetch (#1535). */
  private withTimeout(signal?: AbortSignal): {
    signal: AbortSignal;
    timer: ReturnType<typeof setTimeout>;
    timedOut: () => boolean;
  } {
    const ctrl = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      ctrl.abort(new Error(`Model request timed out after ${this.timeoutMs}ms`));
    }, this.timeoutMs);
    return {
      signal: signal ? AbortSignal.any([signal, ctrl.signal]) : ctrl.signal,
      timer,
      timedOut: () => timedOut,
    };
  }

  /** Shared chat/stream plumbing: rate-limit wait, transport/header
   *  resolution, POST. The client retries only the initial fetch; the loop
   *  owns one guarded replay for a stream body failure with no visible output. */
  private async prepareRequest(
    opts: ChatRequestOptions,
    stream: boolean,
    signal: AbortSignal,
  ): Promise<{ transport: ResolvedTransport | null; resp: Response }> {
    await this.waitForChatRateLimit(signal);
    const transport = await this.resolveTransport();
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (stream) headers.Accept = "text/event-stream";
    if (transport) {
      log.verbose(`${stream ? "stream" : "chat"} → ${transport.endpoint}`);
      Object.assign(headers, transport.headers);
    } else {
      Object.assign(headers, await this.authHeaders());
    }
    const isOllama = providerForModel(opts.model) === "ollama";
    const endpoint =
      transport?.endpoint ??
      (isOllama
        ? `${deriveNativeOllamaOrigin(this.baseUrl)}/api/chat`
        : `${this.baseUrl}/chat/completions`);
    const ollamaNumCtx = isOllama ? await this.resolveOllamaNumCtx(opts) : undefined;
    const resp = await fetchWithRetry(
      this._fetch,
      endpoint,
      {
        method: "POST",
        headers,
        body: stringifyJsonTransport(this.buildPayload(opts, stream, transport, ollamaNumCtx)),
        signal,
      },
      { ...this.retry, signal },
    );
    return { transport, resp };
  }

  private async waitForChatRateLimit(signal?: AbortSignal): Promise<void> {
    if (this.minChatIntervalMs <= 0) return;
    const now = Date.now();
    const waitMs = Math.max(0, this.nextChatRequestAt - now);
    this.nextChatRequestAt = Math.max(now, this.nextChatRequestAt) + this.minChatIntervalMs;
    if (waitMs <= 0) return;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, waitMs);
      signal?.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
        },
        { once: true },
      );
    });
  }

  private buildPayload(
    opts: ChatRequestOptions,
    stream: boolean,
    transport: ResolvedTransport | null,
    ollamaNumCtx?: number,
  ) {
    // The ChatGPT Codex backend speaks the Responses API — chat-completions
    // fields (messages, stream_options, max_tokens, ...) are rejected with a
    // 400, so the whole payload is converted.
    if (transport?.api === "responses") {
      return buildResponsesPayload(opts, stream);
    }
    // Ollama speaks its native `/api/chat` wire format — `options.num_ctx`,
    // `keep_alive` and `think` are all silently dropped by the OpenAI-compat
    // endpoint, so this branch never reaches the chat-completions payload below.
    if (providerForModel(opts.model) === "ollama") {
      return this.buildOllamaPayload(opts, stream, ollamaNumCtx);
    }
    const isOllama = providerForModel(opts.model) === "ollama";
    const payload: Record<string, unknown> = {
      // Ollama model ids are namespaced `ollama/<id>` for provider routing, but
      // the server expects the raw id (`llama3.1:latest`) — strip the prefix.
      model: isOllama ? opts.model.replace(/^ollama\//, "") : opts.model,
      messages: opts.messages,
      stream,
    };
    if (stream) payload.stream_options = { include_usage: true };
    // OpenAI now requires explicit `store: false` — omitting it returns
    // 400 {"detail":"Store must be set to false"}.  DeepSeek ignores it.
    if (providerForModel(opts.model) === "openai") {
      payload.store = false;
      // ChatGPT models default to parallel tool-call bursts in one response.
      // Pin them to one call per response: the loop feeds each result back
      // before the next model round, so a burst is both unsafe (calls run on
      // stale assumptions) and wasted (serial dispatch would just queue them).
      payload.parallel_tool_calls = false;
    }
    if (opts.tools?.length) payload.tools = opts.tools;
    if (opts.temperature !== undefined) payload.temperature = opts.temperature;
    if (opts.maxTokens !== undefined) payload.max_tokens = opts.maxTokens;
    if (opts.responseFormat) payload.response_format = opts.responseFormat;
    // V4 thinking-mode toggle: lives under `extra_body.thinking.type` per
    // DeepSeek's docs. Docs also note that in thinking mode `temperature`,
    // `top_p`, `presence_penalty`, `frequency_penalty` are silently
    // ignored — we don't strip them here because the server's explicit
    // "setting won't report an error" contract means leaving them in is
    // safe and keeps the request payload diffable against OpenAI tooling.
    // OpenAI (and Azure) reject the proprietary field — GPT models control
    // reasoning via reasoning_effort instead, so never send it for them.
    // Proprietary fields are provider-locked: DeepSeek's thinking toggle and
    // reasoning_effort are rejected (or ignored) by other backends — Ollama's
    // OpenAI-compat layer maps only known chat fields.
    if (
      opts.thinking &&
      !this._isAzureEndpoint() &&
      !isOllama &&
      providerForModel(opts.model) !== "openai"
    ) {
      payload.extra_body = { thinking: { type: opts.thinking } };
    }
    if (opts.reasoningEffort && !isOllama) {
      payload.reasoning_effort = opts.reasoningEffort;
    }
    return payload;
  }

  /** Native `/api/chat` payload — the compat endpoint drops `options.num_ctx`,
   *  `keep_alive` and `think`, so this path is the only way to control them. */
  private buildOllamaPayload(
    opts: ChatRequestOptions,
    stream: boolean,
    ollamaNumCtx?: number,
  ): Record<string, unknown> {
    const options: Record<string, unknown> = {};
    if (opts.maxTokens !== undefined) options.num_predict = opts.maxTokens;
    if (opts.temperature !== undefined) options.temperature = opts.temperature;
    if (ollamaNumCtx !== undefined) options.num_ctx = ollamaNumCtx;
    const payload: Record<string, unknown> = {
      // `ollama/<id>` namespacing is client-side routing — the server wants the raw id.
      model: opts.model.replace(/^ollama\//, ""),
      messages: opts.messages.map((m) => toNativeOllamaMessage(m)),
      stream,
    };
    if (Object.keys(options).length > 0) payload.options = options;
    payload.keep_alive = opts.ollama?.keepAlive ?? loadOllamaKeepAlive();
    if (opts.tools?.length) payload.tools = opts.tools;
    if (opts.responseFormat?.type === "json_object") payload.format = "json";
    const think = ollamaThinkValue(opts);
    if (think !== undefined) payload.think = think;
    return payload;
  }

  /** Azure OpenAI-compatible endpoints do not accept DeepSeek's proprietary
   *  `extra_body.thinking` field (they reject the request with 400).  We still
   *  send `reasoning_effort`, which Azure *does* support. */
  private _isAzureEndpoint(): boolean {
    try {
      const host = new URL(this.baseUrl).hostname;
      return host === "azure.com" || host.endsWith(".azure.com");
    } catch {
      return false;
    }
  }

  /** True for api.deepseek.com / *.deepseek.com — the only hosts that get
   *  DeepSeek-branded error prefixes and balance probes. */
  private _isDeepSeekEndpoint(): boolean {
    try {
      return new URL(this.baseUrl).hostname.toLowerCase().endsWith(".deepseek.com");
    } catch {
      return false;
    }
  }

  /** Error-prefix brand for formatLoopError — "DeepSeek NNN" on DeepSeek hosts,
   *  "Upstream NNN" everywhere else (OpenAI, proxies, local gateways). */
  private _errorPrefix(): string {
    return this._isDeepSeekEndpoint() ? "DeepSeek" : "Upstream";
  }

  /** Returns null on failure so callers can degrade — session must keep working without balance UI. */
  async getBalance(opts: { signal?: AbortSignal } = {}): Promise<UserBalance | null> {
    try {
      const resp = await this._fetch(`${this.baseUrl}/user/balance`, {
        method: "GET",
        headers: await this.authHeaders(),
        signal: opts.signal,
      });
      if (!resp.ok) return null;
      const data = (await resp.json()) as UserBalance;
      if (!data || !Array.isArray(data.balance_infos)) return null;
      return data;
    } catch {
      return null;
    }
  }

  /** Returns null on failure — callers fall back to a hardcoded model hint. */
  async listModels(opts: { signal?: AbortSignal } = {}): Promise<ModelList | null> {
    try {
      const resp = await this._fetch(`${this.baseUrl}/models`, {
        method: "GET",
        headers: await this.authHeaders(),
        signal: opts.signal,
      });
      if (!resp.ok) return null;
      const data = (await resp.json()) as ModelList;
      if (!data || !Array.isArray(data.data)) return null;
      return data;
    } catch {
      return null;
    }
  }

  async chat(opts: ChatRequestOptions): Promise<ChatResponse> {
    // The ChatGPT Codex backend (Responses API) requires stream:true —
    // non-streaming requests return 400 {"detail":"Stream must be set to true"}.
    // Resolve the transport early so we can route to an internal streaming
    // collector when needed, matching what the main turn loop already does.
    const transport = await this.resolveTransport();
    if (transport?.api === "responses") {
      return this.chatViaStream(opts);
    }
    if (providerForModel(opts.model) === "ollama") {
      return this.chatOllama(opts);
    }
    if (providerForModel(opts.model) === "gemini") {
      return this.chatGemini(opts);
    }
    const { signal, timer } = this.withTimeout(opts.signal);
    try {
      const { resp } = await this.prepareRequest(opts, false, signal);
      if (!resp.ok) {
        throw new Error(`${this._errorPrefix()} ${resp.status}: ${await resp.text()}`);
      }
      const data: any = await resp.json();
      const choice = data.choices?.[0]?.message ?? {};
      return {
        content: choice.content ?? "",
        reasoningContent: choice.reasoning_content ?? choice.reasoning ?? null,
        toolCalls: choice.tool_calls ?? [],
        usage: Usage.fromApi(data.usage ?? data),
        raw: data,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  /** Native `/api/chat` non-streaming response — `message` instead of
   *  `choices[0].message`, tool-call arguments as objects, metrics inline. */
  private async chatOllama(opts: ChatRequestOptions): Promise<ChatResponse> {
    const { signal, timer } = this.withTimeout(opts.signal);
    try {
      const { resp } = await this.prepareRequest(opts, false, signal);
      if (!resp.ok) {
        throw new Error(`${this._errorPrefix()} ${resp.status}: ${await resp.text()}`);
      }
      const data: any = await resp.json();
      const message = data.message ?? {};
      const toolCalls: ToolCall[] = (message.tool_calls ?? []).map((tc: any) => ({
        id: tc.id,
        type: "function" as const,
        function: {
          name: tc.function?.name ?? "",
          arguments: stringifyNativeToolCallArguments(tc.function?.arguments),
        },
      }));
      return {
        content: message.content ?? "",
        reasoningContent: message.thinking ?? null,
        toolCalls,
        usage: this.usageForOllama(opts, data),
        raw: data,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  /** Resolve the Google OAuth token + Cloud Code project id for a gemini
   *  request. Throws a clear error when the user isn't signed in. */
  private async resolveGeminiAuth(): Promise<{ accessToken: string; projectId: string }> {
    if (!this.geminiAuthResolver) {
      throw new Error("Gemini models require Antigravity sign-in — no auth resolver configured.");
    }
    const auth = await this.geminiAuthResolver();
    if (!auth?.accessToken) {
      throw new Error(
        "Not signed in to Google Antigravity — sign in from settings to use gemini models.",
      );
    }
    if (!auth.projectId) {
      throw new Error(
        "Google Antigravity did not provide a companion project for Gemini quota. Sign out and sign in again.",
      );
    }
    return { accessToken: auth.accessToken, projectId: auth.projectId };
  }

  /** Cloud Code non-streaming response — unwraps the `{response:{candidates,
   *  usageMetadata}}` envelope into a ChatResponse. */
  private parseAntigravityResponse(data: any): ChatResponse {
    const inner = data?.response ?? {};
    const candidate = inner.candidates?.[0];
    const parts = candidate?.content?.parts ?? [];
    let content = "";
    let image: { dataUrl: string; mimeType: string } | undefined;
    const toolCalls: ToolCall[] = [];
    for (const part of parts) {
      if (typeof part.text === "string") content += part.text;
      if (part.inlineData?.data && part.inlineData?.mimeType) {
        image = {
          dataUrl: `data:${part.inlineData.mimeType};base64,${part.inlineData.data}`,
          mimeType: part.inlineData.mimeType,
        };
      }
      if (part.functionCall) {
        toolCalls.push({
          type: "function" as const,
          function: {
            name: part.functionCall.name ?? "",
            arguments: JSON.stringify(part.functionCall.args ?? {}),
          },
          // Part.thought_signature is a SIBLING of functionCall, not nested.
          thoughtSignature: part.thoughtSignature,
        });
      }
    }
    const usage = inner.usageMetadata;
    return {
      content,
      reasoningContent: null,
      toolCalls,
      image,
      usage: new Usage(
        usage?.promptTokenCount ?? 0,
        usage?.candidatesTokenCount ?? 0,
        usage?.totalTokenCount ?? 0,
      ),
      raw: data,
    };
  }

  private async fetchAntigravity(
    path: string,
    accessToken: string,
    init: RequestInit,
  ): Promise<Response> {
    return this._fetch(`${ANTIGRAVITY_CLOUD_CODE_URL}${path}`, {
      ...init,
      headers: { ...antigravityHeaders(accessToken), ...init.headers },
    });
  }

  private async antigravityUpstreamError(resp: Response): Promise<Error> {
    const body = await resp.text().catch(() => "");
    if (resp.status === 403 && body.includes("SUBSCRIPTION_REQUIRED")) {
      return new Error(
        "Google Antigravity rejected this request as licensed Gemini Code Assist access (#3501). Sign out and sign in again so Reasonix can refresh the current Antigravity client identity, companion project, and account model catalog. The selected model was not downgraded or retried.",
      );
    }
    return new Error(`Upstream ${resp.status}: ${body}`);
  }

  /** Cloud Code non-streaming request — `POST /v1internal:generateContent`. */
  private async chatGemini(opts: ChatRequestOptions): Promise<ChatResponse> {
    const auth = await this.resolveGeminiAuth();
    const { signal, timer } = this.withTimeout(opts.signal);
    try {
      const resp = await this.fetchAntigravity("/v1internal:generateContent", auth.accessToken, {
        method: "POST",
        body: stringifyJsonTransport(this.buildAntigravityPayload(opts, auth.projectId)),
        signal,
      });
      if (!resp.ok) {
        throw await this.antigravityUpstreamError(resp);
      }
      return this.parseAntigravityResponse(await resp.json());
    } finally {
      clearTimeout(timer);
    }
  }

  /** Cloud Code streaming request — `POST /v1internal:streamGenerateContent?alt=sse`.
   *  Each SSE event carries a `{response:{candidates,usageMetadata}}` envelope. */
  private async *streamGemini(opts: ChatRequestOptions): AsyncGenerator<StreamChunk> {
    const auth = await this.resolveGeminiAuth();
    const { signal, timer, timedOut } = this.withTimeout(opts.signal);
    let resp: Response;
    try {
      resp = await this.fetchAntigravity(
        "/v1internal:streamGenerateContent?alt=sse",
        auth.accessToken,
        {
          method: "POST",
          headers: { accept: "text/event-stream" },
          body: stringifyJsonTransport(this.buildAntigravityPayload(opts, auth.projectId)),
          signal,
        },
      );
    } catch (err) {
      clearTimeout(timer);
      throw err;
    }
    if (!resp.ok || !resp.body) {
      clearTimeout(timer);
      throw await this.antigravityUpstreamError(resp);
    }
    const queue: StreamChunk[] = [];
    let done = false;
    const parser = createParser({
      onEvent: (ev: EventSourceMessage) => {
        if (!ev.data || ev.data === "[DONE]") {
          done = true;
          return;
        }
        try {
          const json = JSON.parse(ev.data);
          const chunk = this.parseAntigravityStreamChunk(json);
          if (chunk) queue.push(chunk);
        } catch {
          /* skip malformed sse frame */
        }
      },
    });
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    try {
      while (true) {
        if (queue.length > 0) {
          yield queue.shift()!;
          continue;
        }
        if (done) break;
        let value: Uint8Array | undefined;
        let streamDone: boolean;
        try {
          ({ value, done: streamDone } = await reader.read());
        } catch (readErr) {
          const cause = readErr instanceof Error ? readErr : new Error(String(readErr));
          const code = "code" in cause && typeof cause.code === "string" ? cause.code : undefined;
          throw Object.assign(new Error(`SSE body read failed: ${cause.message}`), {
            phase: "stream_body_read" as const,
            code,
            timedOut: timedOut(),
          });
        }
        if (streamDone) break;
        parser.feed(decoder.decode(value, { stream: true }));
      }
      while (queue.length > 0) yield queue.shift()!;
    } finally {
      clearTimeout(timer);
      reader.releaseLock();
    }
  }

  /** Map one Cloud Code SSE envelope to a StreamChunk, or null when it carries
   *  no usable content. */
  private parseAntigravityStreamChunk(json: any): StreamChunk | null {
    const inner = json?.response;
    if (!inner) return null;
    const chunk: StreamChunk = { raw: json };
    if (inner.usageMetadata) {
      chunk.usage = new Usage(
        inner.usageMetadata.promptTokenCount ?? 0,
        inner.usageMetadata.candidatesTokenCount ?? 0,
        inner.usageMetadata.totalTokenCount ?? 0,
      );
    }
    const candidate = inner.candidates?.[0];
    if (!candidate) return chunk;
    if (candidate.finishReason) chunk.finishReason = candidate.finishReason;
    const parts = candidate.content?.parts ?? [];
    for (const part of parts) {
      if (typeof part.text === "string" && part.text.length > 0) {
        chunk.contentDelta = (chunk.contentDelta ?? "") + part.text;
      }
      if (part.inlineData?.data && part.inlineData?.mimeType) {
        chunk.image = {
          dataUrl: `data:${part.inlineData.mimeType};base64,${part.inlineData.data}`,
          mimeType: part.inlineData.mimeType,
        };
      }
      if (part.functionCall) {
        chunk.toolCallDelta = {
          index: 0,
          name: part.functionCall.name,
          argumentsDelta: JSON.stringify(part.functionCall.args ?? {}),
          // Gemini 3.x requires the model's thoughtSignature to be echoed back
          // unchanged on the next request, or the tool continuation 400s.
          // Part.thought_signature is a SIBLING of functionCall, not nested.
          thoughtSignature: part.thoughtSignature,
        };
      }
    }
    if (
      chunk.contentDelta !== undefined ||
      chunk.toolCallDelta !== undefined ||
      chunk.usage !== undefined ||
      chunk.finishReason !== undefined ||
      chunk.image !== undefined
    ) {
      return chunk;
    }
    return null;
  }

  /** Cloud Code request body — `{ model, project, request: { contents,
   *  systemInstruction, generationConfig, tools, toolConfig } }`. */
  private buildAntigravityPayload(
    opts: ChatRequestOptions,
    projectId?: string,
  ): Record<string, unknown> {
    const contents: Array<Record<string, unknown>> = [];
    let systemInstruction: string | undefined;
    // Consecutive tool messages (results of one parallel assistant turn) must
    // be coalesced into a single `user` content with one functionResponse per
    // result. Gemini rejects a `role: "function"` content and rejects duplicate
    // consecutive roles; Google's own client emits one combined user turn.
    let pendingFunctionResponses: Array<Record<string, unknown>> = [];
    const flushFunctionResponses = (): void => {
      if (pendingFunctionResponses.length === 0) return;
      contents.push({ role: "user", parts: pendingFunctionResponses });
      pendingFunctionResponses = [];
    };
    for (const msg of opts.messages) {
      switch (msg.role) {
        case "system": {
          const text = messageText(msg);
          systemInstruction = systemInstruction ? `${systemInstruction}\n\n${text}` : text;
          break;
        }
        case "user": {
          flushFunctionResponses();
          const parts: Array<Record<string, unknown>> = [];
          if (typeof msg.content === "string") {
            if (msg.content.length > 0) parts.push({ text: msg.content });
          } else if (Array.isArray(msg.content)) {
            for (const part of msg.content) {
              if (part.type === "text") parts.push({ text: part.text });
              else if (part.type === "image_url") {
                const parsed = parseDataUrl(part.image_url.url);
                parts.push({ inlineData: { mimeType: parsed.mimeType, data: parsed.data } });
              }
            }
          }
          // Gemini rejects contents with zero parts; drop them defensively.
          if (parts.length > 0) contents.push({ role: "user", parts });
          break;
        }
        case "assistant": {
          flushFunctionResponses();
          const parts: Array<Record<string, unknown>> = [];
          if (typeof msg.content === "string") {
            if (msg.content.length > 0) parts.push({ text: msg.content });
          } else if (Array.isArray(msg.content)) {
            for (const part of msg.content) {
              if (part.type === "text" && part.text.length > 0) parts.push({ text: part.text });
            }
          }
          for (const tc of msg.tool_calls ?? []) {
            const call: Record<string, unknown> = {
              name: tc.function.name,
              args: parseToolCallArguments(tc.function.arguments),
            };
            // Echo the model's thought signature back unchanged as a SIBLING of
            // functionCall — Part.thought_signature is a top-level field, not a
            // nested functionCall field. Nesting it 400s (INVALID_ARGUMENT:
            // "Function call is missing a thought_signature").
            const part: Record<string, unknown> = { functionCall: call };
            if (tc.thoughtSignature) part.thoughtSignature = tc.thoughtSignature;
            parts.push(part);
          }
          if (parts.length > 0) contents.push({ role: "model", parts });
          break;
        }
        case "tool": {
          // Healing guarantees every tool message pairs with a preceding call,
          // so name is present; skip nameless results defensively (Gemini 400s
          // on an empty functionResponse name).
          const name = msg.name ?? "";
          if (name.length === 0) break;
          pendingFunctionResponses.push({
            functionResponse: { name, response: toolResultContent(msg.content) },
          });
          break;
        }
      }
    }
    flushFunctionResponses();
    const request: Record<string, unknown> = {
      contents,
      generationConfig: {
        ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
        ...(opts.maxTokens !== undefined ? { maxOutputTokens: opts.maxTokens } : {}),
        thinkingConfig: { includeThoughts: false },
      },
    };
    if (systemInstruction) {
      request.systemInstruction = { role: "user", parts: [{ text: systemInstruction }] };
    }
    if (opts.tools?.length) {
      request.tools = [
        {
          functionDeclarations: opts.tools.map((t) => ({
            name: t.function.name,
            description: t.function.description,
            parameters: sanitizeGeminiSchema(t.function.parameters),
          })),
        },
      ];
      request.toolConfig = { functionCallingConfig: { mode: "AUTO" } };
    }
    return {
      model: opts.model,
      project: projectId,
      user_prompt_id: globalThis.crypto.randomUUID(),
      request,
    };
  }

  /** Collect a streaming response into a single ChatResponse — used when the
   *  transport requires streaming (Codex/Responses API). */
  private async chatViaStream(opts: ChatRequestOptions): Promise<ChatResponse> {
    let content = "";
    let reasoning = "";
    const toolCallBuilders = new Map<number, { id?: string; name?: string; args: string }>();
    let usage = new Usage();
    let raw: unknown;

    for await (const chunk of this.stream(opts)) {
      if (chunk.contentDelta) content += chunk.contentDelta;
      if (chunk.reasoningDelta) reasoning += chunk.reasoningDelta;
      if (chunk.toolCallDelta) {
        const tc = chunk.toolCallDelta;
        let builder = toolCallBuilders.get(tc.index);
        if (!builder) {
          builder = { id: tc.id, name: tc.name, args: "" };
          toolCallBuilders.set(tc.index, builder);
        }
        if (tc.id) builder.id = tc.id;
        if (tc.name) builder.name = tc.name;
        if (tc.argumentsDelta) builder.args += tc.argumentsDelta;
      }
      if (chunk.usage) usage = chunk.usage;
      if (chunk.raw !== undefined) raw = chunk.raw;
    }

    const toolCalls: ToolCall[] = [];
    for (const [, b] of toolCallBuilders) {
      toolCalls.push({
        id: b.id,
        type: "function" as const,
        function: { name: b.name ?? "", arguments: b.args },
      });
    }

    return { content, reasoningContent: reasoning || null, toolCalls, usage, raw };
  }

  /** Native `/api/chat` streaming — Ollama streams newline-delimited JSON, not
   *  SSE. Each line is a full object: content arrives as deltas, tool calls
   *  arrive complete, and the final `done: true` line carries the metrics. */
  private async *streamOllama(opts: ChatRequestOptions): AsyncGenerator<StreamChunk> {
    const { signal, timer, timedOut } = this.withTimeout(opts.signal);
    let resp: Response;
    try {
      ({ resp } = await this.prepareRequest(opts, true, signal));
    } catch (err) {
      clearTimeout(timer);
      throw err;
    }
    if (!resp.ok || !resp.body) {
      clearTimeout(timer);
      throw new Error(
        `${this._errorPrefix()} ${resp.status}: ${await resp.text().catch(() => "")}`,
      );
    }
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let sawDone = false;
    const emitLine = (line: string): void => {
      if (!line.trim()) return;
      let json: any;
      try {
        json = JSON.parse(line);
      } catch {
        return; // skip malformed frame
      }
      if (json.done === true) sawDone = true;
      const chunk = this.parseNativeOllamaChunk(opts, json);
      if (chunk) queue.push(chunk);
    };
    const queue: StreamChunk[] = [];
    try {
      while (true) {
        if (queue.length > 0) {
          yield queue.shift()!;
          continue;
        }
        let value: Uint8Array | undefined;
        let streamDone: boolean;
        try {
          ({ value, done: streamDone } = await reader.read());
        } catch (readErr) {
          const cause = readErr instanceof Error ? readErr : new Error(String(readErr));
          const code = "code" in cause && typeof cause.code === "string" ? cause.code : undefined;
          throw Object.assign(new Error(`Ollama stream body read failed: ${cause.message}`), {
            phase: "stream_body_read" as const,
            code,
            timedOut: timedOut(),
          });
        }
        if (streamDone) break;
        buffer += decoder.decode(value, { stream: true });
        let newline = buffer.indexOf("\n");
        while (newline >= 0) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          emitLine(line);
          newline = buffer.indexOf("\n");
        }
      }
      // A trailing frame without a final newline.
      if (buffer.trim()) emitLine(buffer);
      while (queue.length > 0) yield queue.shift()!;
      // Ollama always terminates a complete stream with a `done: true` frame.
      // Hitting EOF without it means the generation was cut short (connection
      // dropped, runner killed mid-response) — surface it as a retryable error
      // rather than silently returning a truncated answer.
      if (!sawDone) {
        throw Object.assign(
          new Error("Ollama stream terminated before the `done` completion frame"),
          { phase: "stream_body_read" as const, timedOut: timedOut() },
        );
      }
    } finally {
      clearTimeout(timer);
      reader.releaseLock();
    }
  }

  /** Convert one native NDJSON line into a StreamChunk. Content and thinking
   *  arrive as deltas; tool calls are complete objects; the done line carries
   *  the metrics and the finish reason. */
  private parseNativeOllamaChunk(opts: ChatRequestOptions, json: any): StreamChunk | null {
    const chunk: StreamChunk = { raw: json };
    const message = json.message ?? {};
    if (typeof message.content === "string" && message.content.length > 0) {
      chunk.contentDelta = message.content;
    }
    if (typeof message.thinking === "string" && message.thinking.length > 0) {
      chunk.reasoningDelta = message.thinking;
    }
    if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
      const tc = message.tool_calls[0];
      chunk.toolCallDelta = {
        index: 0,
        id: tc.id,
        name: tc.function?.name ?? "",
        argumentsDelta: stringifyNativeToolCallArguments(tc.function?.arguments),
      };
    }
    if (json.done === true) {
      chunk.finishReason =
        typeof json.done_reason === "string" && json.done_reason ? json.done_reason : "stop";
      if (json.prompt_eval_count !== undefined || json.eval_count !== undefined) {
        chunk.usage = this.usageForOllama(opts, json);
      }
    }
    return chunk.contentDelta !== undefined ||
      chunk.reasoningDelta !== undefined ||
      chunk.toolCallDelta !== undefined ||
      chunk.usage !== undefined ||
      chunk.finishReason !== undefined
      ? chunk
      : null;
  }

  /** Ollama reports prompt_eval_count / eval_count / durations, never a
   *  cache-hit split — cache-hit tokens are inferred from prefix overlap
   *  between consecutive requests (see applyOllamaCacheEstimate). */
  private usageForOllama(opts: ChatRequestOptions, raw: RawUsage): Usage {
    const usage = Usage.fromApi(raw);
    this.applyOllamaCacheEstimate(opts, usage);
    return usage;
  }

  /** Infer cache-hit tokens from the message prefix shared with the previous
   *  request; Ollama reports no hit/miss split, so this is a local estimate
   *  that shrinks on tool-list changes and folds. */
  private applyOllamaCacheEstimate(opts: ChatRequestOptions, usage: Usage): void {
    if (usage.promptTokens <= 0 || opts.messages.length === 0) return;
    const toolsKey = JSON.stringify(opts.tools ?? []);
    const previous = this.ollamaLastSent.get(opts.model);
    let hitTokens = 0;
    if (previous && previous.toolsKey === toolsKey) {
      const max = Math.min(previous.messages.length, opts.messages.length);
      let common = 0;
      while (common < max && sameMessage(previous.messages[common]!, opts.messages[common]!)) {
        common++;
      }
      if (common > 0) {
        hitTokens = estimateRequestTokens(opts.messages.slice(0, common), opts.tools);
      }
    }
    this.ollamaLastSent.set(opts.model, { messages: [...opts.messages], toolsKey });
    if (hitTokens > 0) {
      usage.promptCacheHitTokens = Math.min(hitTokens, usage.promptTokens);
      usage.promptCacheMissTokens = Math.max(0, usage.promptTokens - usage.promptCacheHitTokens);
      usage.totalTokens =
        usage.promptCacheHitTokens + usage.promptCacheMissTokens + usage.completionTokens;
    }
  }

  /** num_ctx for an Ollama request: explicit option > config/env > a lazy
   *  `/api/show` probe (cached, fail-soft) — so server and compaction agree. */
  private async resolveOllamaNumCtx(opts: ChatRequestOptions): Promise<number | undefined> {
    if (opts.ollama?.numCtx !== undefined) return opts.ollama.numCtx;
    const configured = loadOllamaNumCtx();
    if (configured !== undefined) return configured;
    const cached = this.ollamaContextCache.get(opts.model);
    if (cached && Date.now() - cached.at < OLLAMA_SHOW_PROBE_TTL_MS) return cached.contextTokens;
    const contextTokens = await this.probeOllamaContextLength(opts.model);
    this.ollamaContextCache.set(opts.model, { at: Date.now(), contextTokens });
    return contextTokens;
  }

  /** GET {origin}/api/show — the model's max context length, not the runner's
   *  current num_ctx. Fail-soft: unknown means the caller sends no num_ctx. */
  private async probeOllamaContextLength(model: string): Promise<number | undefined> {
    try {
      const resp = await this._fetch(
        `${deriveNativeOllamaOrigin(this.baseUrl)}/api/show?model=${encodeURIComponent(
          model.replace(/^ollama\//, ""),
        )}`,
        { headers: await this.authHeaders(), signal: AbortSignal.timeout(10_000) },
      );
      if (!resp.ok) return undefined;
      return showPayloadContextLength(await resp.json().catch(() => undefined));
    } catch {
      return undefined;
    }
  }

  async *stream(opts: ChatRequestOptions): AsyncGenerator<StreamChunk> {
    if (providerForModel(opts.model) === "ollama") {
      yield* this.streamOllama(opts);
      return;
    }
    if (providerForModel(opts.model) === "gemini") {
      yield* this.streamGemini(opts);
      return;
    }
    const { signal, timer, timedOut } = this.withTimeout(opts.signal);
    let transport: ResolvedTransport | null = null;
    let resp: Response;
    try {
      ({ transport, resp } = await this.prepareRequest(opts, true, signal));
    } catch (err) {
      clearTimeout(timer);
      throw err;
    }
    if (!resp.ok || !resp.body) {
      clearTimeout(timer);
      throw new Error(
        `${this._errorPrefix()} ${resp.status}: ${await resp.text().catch(() => "")}`,
      );
    }

    const queue: StreamChunk[] = [];
    let done = false;
    let streamError: Error | null = null;
    const responsesMode = transport?.api === "responses";
    // Responses streams tool-call arguments incrementally; some backends only
    // emit the full snapshot in output_item.done — the fallback below covers
    // that case. Tracked per output slot so the snapshot never double-appends
    // arguments that already arrived as deltas.
    const argDeltaIndices = new Set<number>();
    const parser = createParser({
      onEvent: (ev: EventSourceMessage) => {
        if (!ev.data || ev.data === "[DONE]") {
          done = true;
          return;
        }
        try {
          const json = JSON.parse(ev.data);
          if (responsesMode) {
            const chunk: StreamChunk = { raw: json };
            const outputIndex: number = json.output_index ?? 0;
            switch (json.type) {
              case "response.output_text.delta":
                if (typeof json.delta === "string" && json.delta.length > 0) {
                  chunk.contentDelta = json.delta;
                }
                break;
              case "response.reasoning_summary_text.delta":
              case "response.reasoning_text.delta":
                if (typeof json.delta === "string" && json.delta.length > 0) {
                  chunk.reasoningDelta = json.delta;
                }
                break;
              case "response.output_item.added": {
                const item = json.item;
                if (item?.type === "function_call") {
                  chunk.toolCallDelta = {
                    index: outputIndex,
                    id: item.call_id,
                    name: item.name,
                    argumentsDelta: "",
                  };
                }
                break;
              }
              case "response.function_call_arguments.delta":
                if (typeof json.delta === "string") {
                  argDeltaIndices.add(outputIndex);
                  chunk.toolCallDelta = { index: outputIndex, argumentsDelta: json.delta };
                }
                break;
              case "response.output_item.done": {
                const item = json.item;
                if (item?.type === "function_call" && !argDeltaIndices.has(outputIndex)) {
                  chunk.toolCallDelta = {
                    index: outputIndex,
                    id: item.call_id,
                    name: item.name,
                    argumentsDelta: item.arguments,
                  };
                }
                break;
              }
              case "response.completed":
                if (json.response?.usage) chunk.usage = Usage.fromApi(json.response.usage);
                chunk.finishReason = json.response?.status === "incomplete" ? "incomplete" : "stop";
                break;
              case "response.incomplete":
                chunk.finishReason = "incomplete";
                break;
              case "response.failed":
                streamError = Object.assign(
                  new Error(
                    `${this._errorPrefix()} 400: ${json.message ?? json.code ?? "response failed"}`,
                  ),
                  { phase: "stream_body_read" as const },
                );
                break;
            }
            if (
              chunk.contentDelta !== undefined ||
              chunk.reasoningDelta !== undefined ||
              chunk.toolCallDelta !== undefined ||
              chunk.usage !== undefined ||
              chunk.finishReason !== undefined
            ) {
              queue.push(chunk);
            }
            return;
          }
          const delta = json.choices?.[0]?.delta ?? {};
          const finishReason = json.choices?.[0]?.finish_reason ?? undefined;
          const chunk: StreamChunk = { raw: json, finishReason };
          if (typeof delta.content === "string" && delta.content.length > 0) {
            chunk.contentDelta = delta.content;
          }
          // DeepSeek streams reasoning as `reasoning_content`; OpenAI GPT-5.x
          // family streams it as `reasoning`. Accept both.
          if (typeof delta.reasoning_content === "string" && delta.reasoning_content.length > 0) {
            chunk.reasoningDelta = delta.reasoning_content;
          } else if (typeof delta.reasoning === "string" && delta.reasoning.length > 0) {
            chunk.reasoningDelta = delta.reasoning;
          }
          if (Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0) {
            const tc = delta.tool_calls[0];
            chunk.toolCallDelta = {
              index: tc.index ?? 0,
              id: tc.id,
              name: tc.function?.name,
              argumentsDelta: tc.function?.arguments,
            };
          }
          const rawUsage = json.usage ?? (Usage.hasApiUsage(json) ? json : undefined);
          if (rawUsage) {
            chunk.usage = Usage.fromApi(rawUsage);
          }
          queue.push(chunk);
        } catch {
          /* skip malformed sse frame */
        }
      },
    });

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    try {
      while (true) {
        if (queue.length > 0) {
          yield queue.shift()!;
          continue;
        }
        if (done) break;
        if (streamError) throw streamError;
        let value: Uint8Array | undefined;
        let streamDone: boolean;
        try {
          ({ value, done: streamDone } = await reader.read());
        } catch (readErr) {
          const cause = readErr instanceof Error ? readErr : new Error(String(readErr));
          const code = "code" in cause && typeof cause.code === "string" ? cause.code : undefined;
          throw Object.assign(new Error(`SSE body read failed: ${cause.message}`), {
            phase: "stream_body_read" as const,
            code,
            timedOut: timedOut(),
          });
        }
        if (streamDone) break;
        parser.feed(decoder.decode(value, { stream: true }));
      }
      if (streamError) throw streamError;
      while (queue.length > 0) yield queue.shift()!;
    } finally {
      clearTimeout(timer);
      reader.releaseLock();
    }
  }
}

export type { ChatMessage, ToolCall, ToolSpec };
