import { loadTypesafeApiKey } from "../config.js";
import type { ToolRegistry } from "../tools.js";

export const TYPESAFE_API_ROOT = "https://api.typesafe.ai";
export const TYPESAFE_SYSTEM_ONE_URL = `${TYPESAFE_API_ROOT}/v1/systemone`;
export const TYPESAFE_MODELS_URL = `${TYPESAFE_API_ROOT}/v1/models`;
export const DEFAULT_JEV_MODEL = "jev-latest";

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

function validateQuestions(value: unknown): asserts value is Record<string, JevQuestion> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("jev_evaluate: questions must be a non-empty object keyed by question id");
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0) {
    throw new Error("jev_evaluate: questions must contain at least one question");
  }
  for (const [id, raw] of entries) {
    if (!id.trim() || !raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error(`jev_evaluate: question ${JSON.stringify(id)} must be an object`);
    }
    const question = raw as Record<string, unknown>;
    if (!isInstructions(question.instructions)) {
      throw new Error(
        `jev_evaluate: question ${JSON.stringify(id)} requires string or JSON instructions`,
      );
    }
    if (question.type === "noul") {
      if (question.criteria !== undefined) {
        if (
          !question.criteria ||
          typeof question.criteria !== "object" ||
          Array.isArray(question.criteria)
        ) {
          throw new Error(`jev_evaluate: noul question ${JSON.stringify(id)} has invalid criteria`);
        }
        for (const [key, description] of Object.entries(question.criteria)) {
          if ((key !== "true" && key !== "false") || typeof description !== "string") {
            throw new Error(
              `jev_evaluate: noul question ${JSON.stringify(id)} has invalid criteria`,
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
        throw new Error(`jev_evaluate: choice question ${JSON.stringify(id)} requires criteria`);
      }
      const choices = Object.entries(question.criteria);
      if (
        choices.length < 2 ||
        choices.some(
          ([key, description]) => !key || (description !== null && typeof description !== "string"),
        )
      ) {
        throw new Error(
          `jev_evaluate: choice question ${JSON.stringify(id)} requires at least two string or null criteria`,
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
          `jev_evaluate: score question ${JSON.stringify(id)} requires at least two JSON criteria levels`,
        );
      }
      continue;
    }
    throw new Error(
      `jev_evaluate: question ${JSON.stringify(id)} has unsupported type ${JSON.stringify(question.type)}`,
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

export async function validateTypesafeApiKey(
  apiKey: string,
  options: TypesafeValidationOptions = {},
): Promise<TypesafeModelCard[]> {
  const key = apiKey.trim();
  if (!key) throw new Error("TypeSafe API key is required");
  const timeout = AbortSignal.timeout(options.timeoutMs ?? 10_000);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  const endpoint = options.endpoint ?? TYPESAFE_MODELS_URL;
  let response: Response;
  try {
    response = await fetch(endpoint, {
      headers: { Authorization: `Bearer ${key}` },
      signal,
    });
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
    response = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ state, model: DEFAULT_JEV_MODEL, questions }),
      signal: options.signal,
    });
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
      "Use the JAI evaluation provider, officially TypeSafe Jev, to make narrow structured decisions over JSON state. Returns typed Noul probabilities, Choice distributions, or Score distributions using jev-latest. Prefer this tool when code needs a classification, confidence-aware route, rubric score, or yes/no probability. It does not generate chat text.",
    readOnly: true,
    parallelSafe: true,
    parameters: {
      type: "object",
      properties: {
        state: {
          description: "Text or JSON data to evaluate.",
        },
        questions: {
          type: "object",
          description:
            "Question map. Each value has type 'noul', 'choice', or 'score', instructions, and type-specific criteria.",
          additionalProperties: true,
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
