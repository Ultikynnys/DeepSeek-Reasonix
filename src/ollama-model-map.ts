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
}

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

export const OLLAMA_VERDICTS_FILENAME = "ollama-model-map.json";

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
  return (result === "ok" || result === "gated") && typeof at === "number" && Number.isFinite(at);
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
): void {
  let plans = store.plans[plan];
  if (!plans) plans = store.plans[plan] = {};
  let scoped = plans[scope];
  if (!scoped) scoped = plans[scope] = {};
  scoped[model] = { result, at };
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
