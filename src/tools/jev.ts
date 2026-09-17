import { loadTypesafeApiKey } from "../config.js";
import type { ToolRegistry } from "../tools.js";

export const TYPESAFE_API_ROOT = "https://api.typesafe.ai";
export const TYPESAFE_SYSTEM_ONE_URL = `${TYPESAFE_API_ROOT}/v1/systemone`;
export const TYPESAFE_MODELS_URL = `${TYPESAFE_API_ROOT}/v1/models`;
export const DEFAULT_JEV_MODEL = "jev-latest";

/** Bounded retry for transient TypeSafe failures — mirrors the official SDK policy
 *  (connection errors, timeouts, 408, 429, 5xx). 401/403/422 are never retried. */
const TYPESAFE_MAX_RETRIES = 2;
const TYPESAFE_RETRY_BASE_MS = 500;
const TYPESAFE_RETRY_MAX_MS = 5_000;
/** Per-attempt timeout for the evaluation request when the caller supplies none. */
const TYPESAFE_EVAL_TIMEOUT_MS = 30_000;
/** How long a successful key validation is trusted before re-checking. */
const TYPESAFE_VALIDATION_TTL_MS = 10 * 60_000;

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

type JevDescription = string | JsonValue[] | { [key: string]: JsonValue };

export interface JevNoulQuestion {
  type: "noul";
  instructions: JevDescription;
  criteria?: { true?: string; false?: string };
}

export interface JevChoiceQuestion {
  type: "choice";
  instructions: JevDescription;
  criteria: Record<string, string | null>;
}

export interface JevScoreQuestion {
  type: "score";
  instructions: JevDescription;
  criteria: JsonValue[];
}

export type JevQuestion = JevNoulQuestion | JevChoiceQuestion | JevScoreQuestion;

export type JevAnswer =
  | { type: "noul"; noul: number }
  | {
      type: "choice";
      choice: string;
      probabilities: Record<string, number>;
      confidence: number;
    }
  | {
      type: "score";
      score: number;
      legend: Record<string, string>;
      probabilities: Record<string, number>;
      confidence: number;
    };

export interface JevResult {
  model: string;
  answers: Record<string, JevAnswer>;
  usage: { input_tokens: number; output_tokens: number };
}

export interface JevEvaluationOptions {
  apiKey?: string;
  configPath?: string;
  endpoint?: string;
  signal?: AbortSignal;
}

export interface JevToolOptions {
  configPath?: string;
  endpoint?: string;
}

export interface TypesafeModelCard {
  name: string;
  description: string;
  release_date: string;
}

export interface TypesafeValidationOptions {
  endpoint?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Bypass the cached result (still refreshes it on success). */
  force?: boolean;
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || ["string", "number", "boolean"].includes(typeof value)) return true;
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (typeof value !== "object") return false;
  return Object.values(value as Record<string, unknown>).every(isJsonValue);
}

function isInstructions(value: unknown): value is JevDescription {
  return (
    typeof value === "string" || (isJsonValue(value) && value !== null && typeof value === "object")
  );
}

/** Copy-pasteable shape hints — a wrong call must be correctable in one round trip. */
const QUESTION_SHAPES = {
  noul: 'optional, and if present {"true": "<string>", "false": "<string>"} — e.g. {"true": "time-sensitive", "false": "not urgent"}',
  choice:
    'an OBJECT (map) of at least two options, each option id mapped to a description string or null — e.g. {"criteria": {"billing": "Payment issues", "technical": null}} (NOT an array)',
  score:
    'an ORDERED ARRAY of at least two level descriptions, low→high — e.g. {"criteria": ["Calm", "Frustrated", "Very angry"]} (NOT an object/map)',
} as const;

function validateQuestions(value: unknown): asserts value is Record<string, JevQuestion> {
  if (typeof value === "string") {
    throw new Error(
      'jev_evaluate: questions must be a JSON object keyed by question id, not a JSON string — pass the object directly, e.g. {"is_urgent": {"type": "noul", "instructions": "..."}}',
    );
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(
      'jev_evaluate: questions must be a JSON object keyed by question id — e.g. {"is_urgent": {"type": "noul", "instructions": "..."}}',
    );
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0) {
    throw new Error(
      'jev_evaluate: questions must contain at least one question — e.g. {"is_urgent": {"type": "noul", "instructions": "..."}}',
    );
  }
  for (const [id, raw] of entries) {
    if (!id.trim() || !raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error(
        `jev_evaluate: question "${id}" must be an object — e.g. {"type": "noul" | "choice" | "score", "instructions": "..."}`,
      );
    }
    const question = raw as Record<string, unknown>;
    if (!isInstructions(question.instructions)) {
      throw new Error(
        `jev_evaluate: question "${id}" needs "instructions" (a string, or a JSON object/array) — e.g. "Does this convey urgency?"`,
      );
    }
    if (question.type === "noul") {
      if (question.criteria !== undefined) {
        if (
          !question.criteria ||
          typeof question.criteria !== "object" ||
          Array.isArray(question.criteria)
        ) {
          throw new Error(
            `jev_evaluate: noul question "${id}" criteria is ${QUESTION_SHAPES.noul}`,
          );
        }
        for (const [key, description] of Object.entries(question.criteria)) {
          if ((key !== "true" && key !== "false") || typeof description !== "string") {
            throw new Error(
              `jev_evaluate: noul question "${id}" criteria is ${QUESTION_SHAPES.noul}`,
            );
          }
        }
      }
      continue;
    }
    if (question.type === "choice") {
      if (
        !question.criteria ||
        typeof question.criteria !== "object" ||
        Array.isArray(question.criteria)
      ) {
        throw new Error(
          `jev_evaluate: choice question "${id}" needs "criteria" — ${QUESTION_SHAPES.choice}`,
        );
      }
      const choices = Object.entries(question.criteria);
      if (
        choices.length < 2 ||
        choices.some(
          ([key, description]) => !key || (description !== null && typeof description !== "string"),
        )
      ) {
        throw new Error(
          `jev_evaluate: choice question "${id}" needs "criteria" — ${QUESTION_SHAPES.choice}`,
        );
      }
      continue;
    }
    if (question.type === "score") {
      if (
        !Array.isArray(question.criteria) ||
        question.criteria.length < 2 ||
        !question.criteria.every(isJsonValue)
      ) {
        throw new Error(
          `jev_evaluate: score question "${id}" needs "criteria" — ${QUESTION_SHAPES.score}`,
        );
      }
      continue;
    }
    throw new Error(
      `jev_evaluate: question "${id}" has type ${JSON.stringify(question.type)} — must be "noul", "choice", or "score"`,
    );
  }
}

function errorDetail(raw: string): string {
  if (!raw.trim()) return "";
  try {
    const parsed = JSON.parse(raw) as { detail?: unknown; message?: unknown; error?: unknown };
    const detail = parsed.detail ?? parsed.message ?? parsed.error;
    if (typeof detail === "string") return `: ${detail}`;
    if (detail !== undefined) return `: ${JSON.stringify(detail)}`;
  } catch {
    // Non-JSON upstream bodies are intentionally not reflected into tool output.
  }
  return "";
}

function statusError(status: number, body: string): Error {
  const detail = errorDetail(body);
  if (status === 401 || status === 403) return new Error(`TypeSafe authentication failed${detail}`);
  if (status === 422) return new Error(`TypeSafe rejected the evaluation request${detail}`);
  if (status === 429) return new Error(`TypeSafe rate limit exceeded${detail}`);
  if (status === 529) return new Error(`TypeSafe is temporarily overloaded${detail}`);
  return new Error(`TypeSafe API returned HTTP ${status}${detail}`);
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || (status >= 500 && status <= 599);
}

/** Parse `retry-after-ms` / `Retry-After` into milliseconds (prefers the -ms header). */
function parseRetryAfterMs(headers: Headers | undefined): number | undefined {
  if (!headers) return undefined;
  const msHeader = headers.get("retry-after-ms");
  if (msHeader !== null) {
    const ms = Number(msHeader);
    if (Number.isFinite(ms) && ms >= 0) return ms;
  }
  const raw = headers.get("retry-after");
  if (raw === null) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return seconds >= 0 ? seconds * 1000 : undefined;
  const date = Date.parse(raw);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

/** Backoff for a zero-based attempt: server `Retry-After` when present, else capped
 *  exponential with jitter. */
function retryDelayMs(attempt: number, headers?: Headers): number {
  const serverDelay = parseRetryAfterMs(headers);
  if (serverDelay !== undefined) return Math.min(serverDelay, TYPESAFE_RETRY_MAX_MS);
  const exponential = Math.min(TYPESAFE_RETRY_BASE_MS * 2 ** attempt, TYPESAFE_RETRY_MAX_MS);
  return Math.round(exponential * (0.75 + Math.random() * 0.5));
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** One request with bounded retry on transient failure. Each attempt gets a fresh
 *  timeout; a caller abort is re-thrown immediately (never retried). On the final
 *  attempt a retryable non-2xx response is returned for the caller to map. */
async function fetchTypesafeWithRetry(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  callerSignal: AbortSignal | undefined,
): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = callerSignal ? AbortSignal.any([callerSignal, timeout]) : timeout;
    let response: Response;
    try {
      response = await fetch(url, { ...init, signal });
    } catch (error) {
      if (callerSignal?.aborted) throw error;
      if (attempt >= TYPESAFE_MAX_RETRIES) throw error;
      await sleep(retryDelayMs(attempt), callerSignal);
      continue;
    }
    if (response.ok || attempt >= TYPESAFE_MAX_RETRIES || !isRetryableStatus(response.status)) {
      return response;
    }
    await response.body?.cancel().catch(() => undefined);
    await sleep(retryDelayMs(attempt, response.headers), callerSignal);
  }
}

export async function validateTypesafeApiKey(
  apiKey: string,
  options: TypesafeValidationOptions = {},
): Promise<TypesafeModelCard[]> {
  const key = apiKey.trim();
  if (!key) throw new Error("TypeSafe API key is required");
  const endpoint = options.endpoint ?? TYPESAFE_MODELS_URL;
  let response: Response;
  try {
    response = await fetchTypesafeWithRetry(
      endpoint,
      { headers: { Authorization: `Bearer ${key}` } },
      options.timeoutMs ?? 10_000,
      options.signal,
    );
  } catch (error) {
    if (options.signal?.aborted) throw error;
    throw new Error(`Could not validate the TypeSafe API key at ${endpoint}`, { cause: error });
  }
  const body = await response.text();
  if (!response.ok) throw statusError(response.status, body);
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new Error("TypeSafe returned malformed JSON while validating the API key");
  }
  const models = (parsed as { models?: unknown } | null)?.models;
  if (!Array.isArray(models)) {
    throw new Error("TypeSafe returned a malformed model list while validating the API key");
  }
  const cards: TypesafeModelCard[] = [];
  for (const model of models) {
    if (!model || typeof model !== "object") {
      throw new Error("TypeSafe returned a malformed model list while validating the API key");
    }
    const card = model as Record<string, unknown>;
    if (
      typeof card.name !== "string" ||
      typeof card.description !== "string" ||
      typeof card.release_date !== "string"
    ) {
      throw new Error("TypeSafe returned a malformed model list while validating the API key");
    }
    cards.push(card as unknown as TypesafeModelCard);
  }
  if (!cards.some((card) => card.name === DEFAULT_JEV_MODEL || card.name.startsWith("jev-"))) {
    throw new Error("The TypeSafe API key is valid but does not provide access to a Jev model");
  }
  return cards;
}

interface TypesafeValidationCacheEntry {
  expiresAt: number;
  models: TypesafeModelCard[];
}

let typesafeValidationCache: { key: string; entry: TypesafeValidationCacheEntry } | null = null;
let typesafeValidationInFlight: { key: string; promise: Promise<TypesafeModelCard[]> } | null =
  null;

/** Drop the cached key-validation result. Lets tests isolate the module-level cache. */
export function resetTypesafeValidationCache(): void {
  typesafeValidationCache = null;
  typesafeValidationInFlight = null;
}

/** Cache-aware validation for repeated call sites (per-tab toolset builds). A success
 *  is trusted briefly; failures are never cached. `force: true` skips the cache read,
 *  and concurrent calls for one key share a request. */
export function validateTypesafeApiKeyCached(
  apiKey: string,
  options: TypesafeValidationOptions = {},
): Promise<TypesafeModelCard[]> {
  const key = apiKey.trim();
  if (!key) return Promise.reject(new Error("TypeSafe API key is required"));
  const fresh = !options.force;
  if (fresh && typesafeValidationCache?.key === key) {
    if (typesafeValidationCache.entry.expiresAt > Date.now()) {
      return Promise.resolve(typesafeValidationCache.entry.models);
    }
    typesafeValidationCache = null;
  }
  if (fresh && typesafeValidationInFlight?.key === key) {
    return typesafeValidationInFlight.promise;
  }
  const promise = validateTypesafeApiKey(key, options).then(
    (models) => {
      typesafeValidationCache = {
        key,
        entry: { expiresAt: Date.now() + TYPESAFE_VALIDATION_TTL_MS, models },
      };
      if (typesafeValidationInFlight?.key === key) typesafeValidationInFlight = null;
      return models;
    },
    (error: unknown) => {
      if (typesafeValidationInFlight?.key === key) typesafeValidationInFlight = null;
      throw error;
    },
  );
  typesafeValidationInFlight = { key, promise };
  return promise;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function validateResult(value: unknown): JevResult {
  if (!value || typeof value !== "object")
    throw new Error("TypeSafe returned a malformed response");
  const result = value as Record<string, unknown>;
  if (
    typeof result.model !== "string" ||
    !result.answers ||
    typeof result.answers !== "object" ||
    Array.isArray(result.answers)
  ) {
    throw new Error("TypeSafe returned a malformed response");
  }
  const usage = result.usage as Record<string, unknown> | undefined;
  if (!usage || !isFiniteNumber(usage.input_tokens) || !isFiniteNumber(usage.output_tokens)) {
    throw new Error("TypeSafe returned a malformed response");
  }
  for (const answer of Object.values(result.answers as Record<string, unknown>)) {
    if (!answer || typeof answer !== "object")
      throw new Error("TypeSafe returned a malformed response");
    const item = answer as Record<string, unknown>;
    if (item.type === "noul" && isFiniteNumber(item.noul)) continue;
    if (
      item.type === "choice" &&
      typeof item.choice === "string" &&
      item.probabilities &&
      typeof item.probabilities === "object" &&
      isFiniteNumber(item.confidence)
    )
      continue;
    if (
      item.type === "score" &&
      isFiniteNumber(item.score) &&
      item.legend &&
      typeof item.legend === "object" &&
      item.probabilities &&
      typeof item.probabilities === "object" &&
      isFiniteNumber(item.confidence)
    )
      continue;
    throw new Error("TypeSafe returned a malformed response");
  }
  return value as JevResult;
}

export async function evaluateWithJev(
  state: JsonValue,
  questions: Record<string, JevQuestion>,
  options: JevEvaluationOptions = {},
): Promise<JevResult> {
  if (!isJsonValue(state)) throw new Error("jev_evaluate: state must be valid JSON data");
  validateQuestions(questions);
  const apiKey = options.apiKey?.trim() || loadTypesafeApiKey(options.configPath);
  if (!apiKey) {
    throw new Error(
      "Jev requires a TypeSafe API key. Add one in Settings → Models → TypeSafe / Jev.",
    );
  }
  const endpoint = options.endpoint ?? TYPESAFE_SYSTEM_ONE_URL;
  let response: Response;
  try {
    response = await fetchTypesafeWithRetry(
      endpoint,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ state, model: DEFAULT_JEV_MODEL, questions }),
      },
      TYPESAFE_EVAL_TIMEOUT_MS,
      options.signal,
    );
  } catch (error) {
    if (options.signal?.aborted) throw error;
    throw new Error(`Could not reach TypeSafe at ${endpoint}`, { cause: error });
  }
  const body = await response.text();
  if (!response.ok) throw statusError(response.status, body);
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new Error("TypeSafe returned a malformed JSON response");
  }
  return validateResult(parsed);
}

export function registerJevTool(
  registry: ToolRegistry,
  options: JevToolOptions = {},
): ToolRegistry {
  registry.register({
    name: "jev_evaluate",
    description:
      "Use JEV (TypeSafe's System One evaluation model) to make narrow structured decisions over JSON state. Returns typed Noul probabilities, Choice distributions, or Score distributions using jev-latest. Pass 'questions' as a map of {type, instructions, criteria}: noul criteria is an optional {true,false} map, choice criteria is a map of option->description, score criteria is an array of levels. It does not generate chat text.",
    readOnly: true,
    parallelSafe: true,
    parameters: {
      type: "object",
      properties: {
        state: {
          description:
            "Content to evaluate: a plain string (a message, document, etc.), or structured JSON (an object/array — a ticket, chat log, or record).",
        },
        questions: {
          type: "object",
          description: [
            "Map of named questions; each answer returns under the same key. Every value is ONE of three shapes:",
            '• noul (yes/no probability): {"type":"noul","instructions":"<string or JSON>","criteria":{"true":"<what yes means>","false":"<what no means>"}}  (criteria optional)',
            '• choice (pick one): {"type":"choice","instructions":"...","criteria":{"<optionId>":"<description or null>", ...}}  — criteria is an OBJECT (map) with at least two options; NOT an array.',
            '• score (rate on a rubric): {"type":"score","instructions":"...","criteria":["<level 0>","<level 1>", ...]}  — criteria is an ORDERED ARRAY of at least two levels; NOT a map.',
          ].join("\n"),
          additionalProperties: { type: "object" },
        },
      },
      required: ["state", "questions"],
    },
    fn: async (args: { state: JsonValue; questions: Record<string, JevQuestion> }, ctx) =>
      evaluateWithJev(args.state, args.questions, {
        configPath: options.configPath,
        endpoint: options.endpoint,
        signal: ctx?.signal,
      }),
  });
  return registry;
}
