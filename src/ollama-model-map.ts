import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { atomicWriteSync, tmpSiblingPath } from "./core/atomic-write";
import { readJsonFileSilently } from "./core/json-file";
import { reasonixHome } from "./reasonix-home";

/** Learned tier verdict for one Ollama model under one account plan. */
export type OllamaModelVerdict = "ok" | "gated";

export interface OllamaVerdictEntry {
  result: OllamaModelVerdict;
  /** Epoch ms when the verdict was learned — staleness is measured from here. */
  at: number;
  /** Whether the model is vision-capable (multimodal). Absent/undefined
   *  means "unknown" — a legacy entry written before vision probing, or one
   *  where the vision probe couldn't run. */
  vision?: boolean;
  /** Server-side context window in tokens, learned from `/api/show`
   *  `model_info.llama.context_length` — the model's maximum sequence length,
   *  not the runner's default num_ctx (4096). Absent/undefined = unknown. */
  contextTokens?: number;
  /** Learned sampling options from `/api/show` `parameters` string (Modelfile). */
  parameters?: Partial<Record<OllamaGenerationParameterKey, number>>;
}

export type OllamaGenerationParameterKey =
  | "temperature"
  | "topP"
  | "topK"
  | "minP"
  | "seed"
  | "repeatPenalty"
  | "repeatLastN"
  | "frequencyPenalty"
  | "presencePenalty";

/** Official Ollama runtime defaults when unconfigured in Modelfile. */
export const DEFAULT_OLLAMA_GENERATION_VALUES: Record<OllamaGenerationParameterKey, number> = {
  temperature: 0.8,
  topP: 0.9,
  topK: 40,
  minP: 0,
  seed: 0,
  repeatPenalty: 1.1,
  repeatLastN: 64,
  frequencyPenalty: 0,
  presencePenalty: 0,
};

/** Persistent verdict map: `plan -> (endpoint|keyHash) -> model -> entry`.
 *  Scoping by plan means a plan change (free -> pro) starts a fresh catalog
 *  instead of reusing verdicts learned under a different plan. */
export interface OllamaVerdictStore {
  version: 1;
  plans: Record<string, Record<string, Record<string, OllamaVerdictEntry>>>;
}

/** A mapped verdict is trusted for 24 h, then re-probed lazily on the next
 *  refresh so server-side tier flips (observed in the wild: models moving
 *  between 403 and 200 within a session) eventually propagate. */
export const OLLAMA_VERDICT_TTL_MS = 24 * 60 * 60_000;

const OLLAMA_VERDICTS_FILENAME = "ollama-model-map.json";

/** `~/.reasonix/ollama-model-map.json` — global user state, next to config.json. */
export function ollamaVerdictsPath(home: string = reasonixHome()): string {
  return join(home, OLLAMA_VERDICTS_FILENAME);
}

/** Scope key for a verdict map: endpoint plus a sha256 hash of the key, never
 *  the raw key — the file is user-private state, not a secret store. */
export function scopeKeyFor(baseUrl: string, apiKey: string): string {
  const hash = createHash("sha256").update(apiKey).digest("hex").slice(0, 16);
  return `${baseUrl}|${hash}`;
}

export function emptyOllamaVerdicts(): OllamaVerdictStore {
  return { version: 1, plans: {} };
}

function isVerdictEntry(value: unknown): value is OllamaVerdictEntry {
  if (typeof value !== "object" || value === null) return false;
  const result = (value as { result?: unknown }).result;
  const at = (value as { at?: unknown }).at;
  const vision = (value as { vision?: unknown }).vision;
  const contextTokens = (value as { contextTokens?: unknown }).contextTokens;
  const parameters = (value as { parameters?: unknown }).parameters;
  if ((result !== "ok" && result !== "gated") || typeof at !== "number" || !Number.isFinite(at)) {
    return false;
  }
  if (
    contextTokens !== undefined &&
    (typeof contextTokens !== "number" || !Number.isFinite(contextTokens) || contextTokens <= 0)
  ) {
    return false;
  }
  // `vision` is optional — a legacy entry without it is still valid (means unknown).
  if (vision !== undefined && typeof vision !== "boolean") return false;
  if (parameters !== undefined) {
    if (typeof parameters !== "object" || parameters === null || Array.isArray(parameters)) {
      return false;
    }
    for (const v of Object.values(parameters)) {
      if (typeof v !== "number" || !Number.isFinite(v)) return false;
    }
  }
  return true;
}

function isVerdictStore(value: unknown): value is OllamaVerdictStore {
  if (typeof value !== "object" || value === null) return false;
  const store = value as { version?: unknown; plans?: unknown };
  if (store.version !== 1 || typeof store.plans !== "object" || store.plans === null) {
    return false;
  }
  for (const scopes of Object.values(store.plans as Record<string, unknown>)) {
    if (typeof scopes !== "object" || scopes === null) return false;
    for (const perModel of Object.values(scopes as Record<string, unknown>)) {
      if (typeof perModel !== "object" || perModel === null) return false;
      for (const entry of Object.values(perModel as Record<string, unknown>)) {
        if (!isVerdictEntry(entry)) return false;
      }
    }
  }
  return true;
}

/** Read the verdict map, returning an empty store on any failure (missing,
 *  malformed, or wrong shape) — never throws, and an empty map is the safe
 *  direction (re-probe everything rather than hide anything). */
export function loadOllamaVerdicts(path: string): OllamaVerdictStore {
  return readJsonFileSilently(path, isVerdictStore) ?? emptyOllamaVerdicts();
}

/** Persist the verdict map atomically (sibling tmp + rename, mode 0o600). */
export function saveOllamaVerdicts(store: OllamaVerdictStore, path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  atomicWriteSync(path, JSON.stringify(store, null, 2), tmpSiblingPath(path));
}

/** Cached verdict for `model`, or undefined when absent or stale (`now - at >= ttlMs`). */
export function verdictFor(
  store: OllamaVerdictStore,
  plan: string,
  scope: string,
  model: string,
  now: number,
  ttlMs: number = OLLAMA_VERDICT_TTL_MS,
): OllamaVerdictEntry | undefined {
  const entry = store.plans[plan]?.[scope]?.[model];
  if (!entry) return undefined;
  return now - entry.at < ttlMs ? entry : undefined;
}

/** Record a learned verdict for `model` under `plan`/`scope`. */
export function setVerdict(
  store: OllamaVerdictStore,
  plan: string,
  scope: string,
  model: string,
  result: OllamaModelVerdict,
  at: number,
  vision?: boolean,
  contextTokens?: number,
  parameters?: Partial<Record<OllamaGenerationParameterKey, number>>,
): void {
  let plans = store.plans[plan];
  if (!plans) plans = store.plans[plan] = {};
  let scoped = plans[scope];
  if (!scoped) scoped = plans[scope] = {};
  scoped[model] = {
    result,
    at,
    ...(vision === undefined ? {} : { vision }),
    ...(contextTokens === undefined ? {} : { contextTokens }),
    ...(parameters === undefined ? {} : { parameters }),
  };
}

/** Parse generation parameters from a native `/api/show` payload.
 *  Ollama returns a multiline `parameters` string like "temperature 0.7\ntop_p 0.9". */
export function showPayloadParameters(
  data: unknown,
): Partial<Record<OllamaGenerationParameterKey, number>> | undefined {
  if (typeof data !== "object" || data === null) return undefined;
  const rec = data as Record<string, unknown>;
  const raw = rec.parameters;
  if (typeof raw !== "string" || !raw.trim()) return undefined;
  const params: Partial<Record<OllamaGenerationParameterKey, number>> = {};
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = trimmed.match(/^([a-z_]+)\s+([^\s]+)/);
    if (!match) continue;
    const [, name, valStr] = match;
    const num = Number(valStr);
    if (!Number.isFinite(num)) continue;
    switch (name) {
      case "temperature":
        params.temperature = num;
        break;
      case "top_p":
        params.topP = num;
        break;
      case "top_k":
        params.topK = Math.floor(num);
        break;
      case "min_p":
        params.minP = num;
        break;
      case "seed":
        params.seed = Math.floor(num);
        break;
      case "repeat_penalty":
        params.repeatPenalty = num;
        break;
      case "repeat_last_n":
        params.repeatLastN = Math.floor(num);
        break;
      case "frequency_penalty":
        params.frequencyPenalty = num;
        break;
      case "presence_penalty":
        params.presencePenalty = num;
        break;
    }
  }
  return Object.keys(params).length > 0 ? params : undefined;
}

/** Context window in tokens from a native `/api/show` payload — the
 *  `model_info.llama.context_length` key is the model's maximum sequence
 *  length, not the runner's current num_ctx (which defaults to 4096). */
export function showPayloadContextLength(data: unknown): number | undefined {
  if (typeof data !== "object" || data === null) return undefined;
  const rec = data as Record<string, unknown>;
  const modelInfo = rec.model_info;
  if (typeof modelInfo !== "object" || modelInfo === null) return undefined;
  const raw = (modelInfo as Record<string, unknown>)["llama.context_length"];
  if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) return Math.floor(raw);
  return undefined;
}

/** Best-effort context-window lookup across every plan/scope bucket — used at
 *  loop-bootstrap time when the caller may not know the account plan yet.
 *  Returns the freshest entry's contextTokens within the TTL. */
export function contextTokensForModel(
  store: OllamaVerdictStore,
  model: string,
  now: number,
  ttlMs: number = OLLAMA_VERDICT_TTL_MS,
): number | undefined {
  let bestAt = Number.NEGATIVE_INFINITY;
  let best: number | undefined;
  for (const scopes of Object.values(store.plans)) {
    for (const perModel of Object.values(scopes)) {
      const entry = perModel[model];
      if (
        entry &&
        typeof entry.contextTokens === "number" &&
        now - entry.at < ttlMs &&
        entry.at > bestAt
      ) {
        bestAt = entry.at;
        best = entry.contextTokens;
      }
    }
  }
  return best;
}

/** Best-effort sampling parameter lookup across every plan/scope bucket.
 *  Returns the freshest entry's parameters within the TTL. */
export function parametersForModel(
  store: OllamaVerdictStore,
  model: string,
  now: number,
  ttlMs: number = OLLAMA_VERDICT_TTL_MS,
): Partial<Record<OllamaGenerationParameterKey, number>> | undefined {
  const normalized = model.replace(/^ollama\//, "");
  let bestAt = Number.NEGATIVE_INFINITY;
  let best: Partial<Record<OllamaGenerationParameterKey, number>> | undefined;
  for (const scopes of Object.values(store.plans)) {
    for (const perModel of Object.values(scopes)) {
      const entry = perModel[model] ?? perModel[normalized];
      if (entry?.parameters && now - entry.at < ttlMs && entry.at > bestAt) {
        bestAt = entry.at;
        best = entry.parameters;
      }
    }
  }
  return best;
}

/** Resolve effective Ollama defaults for a model: standard Ollama defaults
 *  plus any model-specific Modelfile parameters learned from /api/show. */
export function resolveOllamaModelDefaults(
  model: string,
  store?: OllamaVerdictStore,
): Record<OllamaGenerationParameterKey, number> {
  const verdictStore = store ?? loadOllamaVerdicts(ollamaVerdictsPath());
  const learned = parametersForModel(verdictStore, model, Date.now());
  return {
    ...DEFAULT_OLLAMA_GENERATION_VALUES,
    ...(learned ?? {}),
  };
}

/** Split the model list into `known` (fresh cached verdicts) and `unknown`
 *  (never mapped or stale — these are the only models that need probing). */
export function partitionByVerdicts(
  models: readonly string[],
  store: OllamaVerdictStore,
  plan: string,
  scope: string,
  now: number,
  ttlMs: number = OLLAMA_VERDICT_TTL_MS,
): { known: ReadonlyMap<string, OllamaVerdictEntry>; unknown: string[] } {
  const known = new Map<string, OllamaVerdictEntry>();
  const unknown: string[] = [];
  for (const model of models) {
    const entry = verdictFor(store, plan, scope, model, now, ttlMs);
    if (entry) known.set(model, entry);
    else unknown.push(model);
  }
  return { known, unknown };
}

/** Models (within `models`) whose cached verdict marks them vision-capable.
 *  Only `vision === true` counts — unknown never promises image support. */
export function visionModelsFor(
  models: readonly string[],
  store: OllamaVerdictStore,
  plan: string,
  scope: string,
  now: number,
  ttlMs: number = OLLAMA_VERDICT_TTL_MS,
): ReadonlySet<string> {
  const out = new Set<string>();
  for (const model of models) {
    const entry = verdictFor(store, plan, scope, model, now, ttlMs);
    if (entry?.vision === true) out.add(model);
  }
  return out;
}
