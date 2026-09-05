import { join } from "node:path";
import { OPENCODE_MODELS, OPENCODE_VISION_MODELS, messageOf } from "@reasonix/core-utils";
import { readJsonFileSilently, writeJsonFileSilently } from "./core/json-file.js";
import { fetchWithTimeout } from "./net/timeout-fetch.js";
import { reasonixHome } from "./reasonix-home.js";

/** Endpoint database of models across providers, operated by OpenCode community. */
export const OPENCODE_MODELS_DEV_URL = "https://models.dev/api.json";

/** Cache TTL: 12 hours. Keeps startup fast and network traffic light. */
export const OPENCODE_MODELS_CACHE_TTL_MS = 12 * 60 * 60 * 1000;

/** Network timeout when fetching models.dev. */
export const OPENCODE_MODELS_FETCH_TIMEOUT_MS = 5_000;

export interface OpencodeModelsCacheEntry {
  models: string[];
  visionModels: string[];
  checkedAt: number;
}

export interface OpencodeModelsSnapshot {
  models: string[];
  visionModels: string[];
  checkedAt: number;
  error?: string;
}

export function opencodeModelsCachePath(homeDirOverride?: string): string {
  return join(reasonixHome(homeDirOverride), "opencode-models-cache.json");
}

function isValidCacheEntry(value: unknown): value is OpencodeModelsCacheEntry {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const entry = value as Record<string, unknown>;
  return (
    Array.isArray(entry.models) &&
    entry.models.every((m) => typeof m === "string") &&
    Array.isArray(entry.visionModels) &&
    entry.visionModels.every((m) => typeof m === "string") &&
    typeof entry.checkedAt === "number"
  );
}

export function loadOpencodeModelsCache(homeDirOverride?: string): OpencodeModelsCacheEntry | null {
  return readJsonFileSilently(opencodeModelsCachePath(homeDirOverride), isValidCacheEntry);
}

export function writeOpencodeModelsCache(
  entry: OpencodeModelsCacheEntry,
  homeDirOverride?: string,
): void {
  writeJsonFileSilently(opencodeModelsCachePath(homeDirOverride), entry);
}

export interface FetchOpencodeModelsOptions {
  force?: boolean;
  url?: string;
  homeDir?: string;
  fetchImpl?: typeof fetch;
  ttlMs?: number;
  timeoutMs?: number;
}

export async function fetchOpencodeModels(
  opts: FetchOpencodeModelsOptions = {},
): Promise<OpencodeModelsSnapshot> {
  const ttl = opts.ttlMs ?? OPENCODE_MODELS_CACHE_TTL_MS;
  const cached = loadOpencodeModelsCache(opts.homeDir);

  if (!opts.force && cached && Date.now() - cached.checkedAt < ttl) {
    return cached;
  }

  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const url = opts.url ?? OPENCODE_MODELS_DEV_URL;
  const timeout = opts.timeoutMs ?? OPENCODE_MODELS_FETCH_TIMEOUT_MS;

  try {
    const res = await fetchWithTimeout(url, fetchImpl, timeout, {
      headers: { accept: "application/json" },
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}: ${res.statusText}`);
    }
    const data: unknown = await res.json();
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      throw new Error("Invalid response format from models.dev (expected JSON object)");
    }
    const root = data as Record<string, unknown>;
    const opencode = (root.opencode ?? root["opencode-zen"]) as Record<string, unknown> | undefined;
    const rawModels = (opencode?.models ?? {}) as Record<string, unknown>;

    const modelsSet = new Set<string>();
    const visionSet = new Set<string>();

    for (const [id, rawModel] of Object.entries(rawModels)) {
      if (!rawModel || typeof rawModel !== "object" || Array.isArray(rawModel)) continue;
      const m = rawModel as Record<string, unknown>;
      const cost = m.cost as { input?: number; output?: number } | undefined;
      // Free tier: cost.input === 0
      const isFree = cost ? cost.input === 0 : false;
      if (isFree) {
        modelsSet.add(id);
        if (m.attachment === true) {
          visionSet.add(id);
        }
      }
    }

    // Always include static catalog as base guarantee
    for (const id of OPENCODE_MODELS) modelsSet.add(id);
    for (const id of OPENCODE_VISION_MODELS) visionSet.add(id);

    const snapshot: OpencodeModelsCacheEntry = {
      models: Array.from(modelsSet),
      visionModels: Array.from(visionSet),
      checkedAt: Date.now(),
    };

    writeOpencodeModelsCache(snapshot, opts.homeDir);
    return snapshot;
  } catch (err) {
    const errorMsg = messageOf(err);
    // AntiSilentFallback: Loudly log to stderr that network fetch failed and we fall back to cache/catalog.
    process.stderr.write(
      `reasonix: failed to fetch models.dev (${errorMsg}), falling back to cached/catalog OpenCode models\n`,
    );
    if (cached) {
      return { ...cached, error: errorMsg };
    }
    return {
      models: [...OPENCODE_MODELS],
      visionModels: [...OPENCODE_VISION_MODELS],
      checkedAt: 0,
      error: errorMsg,
    };
  }
}

/** Check whether an arbitrary model ID belongs to the discovered OpenCode models. */
export function isDiscoveredOpencodeModel(modelId: string, homeDirOverride?: string): boolean {
  if (OPENCODE_MODELS.includes(modelId)) return true;
  const cached = loadOpencodeModelsCache(homeDirOverride);
  return Boolean(cached?.models.includes(modelId));
}
