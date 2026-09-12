import { join } from "node:path";
import { readJsonFileSilently, writeJsonFileSilently } from "./core/json-file.js";
import { reasonixHome } from "./reasonix-home.js";

const OLLAMA_MODELS_CACHE_FILENAME = "ollama-models-cache.json";

export interface OllamaModelsCacheEntry {
  models: string[];
  visionModels?: string[];
  plan?: string;
  hiddenCount?: number;
  fetchedAt: number;
}

export interface OllamaModelsCacheStore {
  version: 1;
  entries: Record<string, OllamaModelsCacheEntry>;
}

export function ollamaModelsCachePath(homeDirOverride?: string): string {
  return join(reasonixHome(homeDirOverride), OLLAMA_MODELS_CACHE_FILENAME);
}

function isCacheEntry(value: unknown): value is OllamaModelsCacheEntry {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const entry = value as Record<string, unknown>;
  if (!Array.isArray(entry.models) || !entry.models.every((m) => typeof m === "string")) {
    return false;
  }
  if (
    entry.visionModels !== undefined &&
    (!Array.isArray(entry.visionModels) || !entry.visionModels.every((m) => typeof m === "string"))
  ) {
    return false;
  }
  if (entry.plan !== undefined && typeof entry.plan !== "string") return false;
  if (entry.hiddenCount !== undefined && typeof entry.hiddenCount !== "number") return false;
  if (typeof entry.fetchedAt !== "number" || !Number.isFinite(entry.fetchedAt)) return false;
  return true;
}

function isCacheStore(value: unknown): value is OllamaModelsCacheStore {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const store = value as Record<string, unknown>;
  if (store.version !== 1 || typeof store.entries !== "object" || store.entries === null) {
    return false;
  }
  for (const entry of Object.values(store.entries as Record<string, unknown>)) {
    if (!isCacheEntry(entry)) return false;
  }
  return true;
}

export function loadOllamaModelsCache(
  endpointKey: string,
  homeDirOverride?: string,
): OllamaModelsCacheEntry | null {
  const store = readJsonFileSilently(ollamaModelsCachePath(homeDirOverride), isCacheStore);
  if (!store?.entries) return null;
  return store.entries[endpointKey] ?? null;
}

export function saveOllamaModelsCache(
  endpointKey: string,
  entry: OllamaModelsCacheEntry,
  homeDirOverride?: string,
): void {
  const path = ollamaModelsCachePath(homeDirOverride);
  const currentStore = readJsonFileSilently(path, isCacheStore);
  const store: OllamaModelsCacheStore = {
    version: 1,
    entries: {
      ...(currentStore?.entries ?? {}),
      [endpointKey]: entry,
    },
  };
  writeJsonFileSilently(path, store, { pretty: true });
}
