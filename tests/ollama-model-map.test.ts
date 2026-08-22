/** Persistent per-plan Ollama model verdict map — save/load, scoping, staleness. */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  OLLAMA_VERDICT_TTL_MS,
  emptyOllamaVerdicts,
  loadOllamaVerdicts,
  ollamaVerdictsPath,
  partitionByVerdicts,
  saveOllamaVerdicts,
  scopeKeyFor,
  setVerdict,
  verdictFor,
} from "../src/ollama-model-map.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ollama-model-map-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("scopeKeyFor", () => {
  it("hashes the key — the raw key never appears in the scope", () => {
    const scope = scopeKeyFor("https://ollama.com/v1", "super-secret-key-1");
    expect(scope).not.toContain("super-secret-key-1");
    expect(scope.startsWith("https://ollama.com/v1|")).toBe(true);
  });

  it("distinguishes keys and endpoints", () => {
    expect(scopeKeyFor("https://ollama.com/v1", "a")).not.toBe(
      scopeKeyFor("https://ollama.com/v1", "b"),
    );
    expect(scopeKeyFor("https://ollama.com/v1", "a")).not.toBe(
      scopeKeyFor("http://localhost:11434/v1", "a"),
    );
    expect(scopeKeyFor("https://ollama.com/v1", "a")).toBe(
      scopeKeyFor("https://ollama.com/v1", "a"),
    );
  });
});

describe("loadOllamaVerdicts", () => {
  it("returns an empty store when the file is missing", () => {
    expect(loadOllamaVerdicts(join(dir, "nope.json"))).toEqual(emptyOllamaVerdicts());
  });

  it("returns an empty store when the file is malformed", () => {
    writeFileSync(join(dir, "bad.json"), "{ not json");
    expect(loadOllamaVerdicts(join(dir, "bad.json"))).toEqual(emptyOllamaVerdicts());
  });

  it("returns an empty store when the shape is wrong", () => {
    writeFileSync(join(dir, "bad-shape.json"), JSON.stringify({ version: 2, plans: {} }));
    expect(loadOllamaVerdicts(join(dir, "bad-shape.json"))).toEqual(emptyOllamaVerdicts());
  });
});

describe("saveOllamaVerdicts", () => {
  it("round-trips through disk", () => {
    const path = join(dir, "map.json");
    const store = emptyOllamaVerdicts();
    setVerdict(store, "free", "https://ollama.com/v1|abc", "kimi-k3", "gated", 1_000);
    setVerdict(store, "free", "https://ollama.com/v1|abc", "gpt-oss:20b", "ok", 2_000);
    saveOllamaVerdicts(store, path);
    expect(loadOllamaVerdicts(path)).toEqual(store);
  });

  it("creates parent directories", () => {
    const path = join(dir, "a", "b", "map.json");
    saveOllamaVerdicts(emptyOllamaVerdicts(), path);
    expect(loadOllamaVerdicts(path)).toEqual(emptyOllamaVerdicts());
  });
});

describe("verdictFor + setVerdict", () => {
  it("returns the cached verdict within the TTL", () => {
    const store = emptyOllamaVerdicts();
    setVerdict(store, "free", "s", "m", "gated", 1_000);
    expect(verdictFor(store, "free", "s", "m", 1_000 + OLLAMA_VERDICT_TTL_MS - 1)).toEqual({
      result: "gated",
      at: 1_000,
    });
  });

  it("treats a verdict past the TTL as stale (undefined)", () => {
    const store = emptyOllamaVerdicts();
    setVerdict(store, "free", "s", "m", "gated", 1_000);
    expect(verdictFor(store, "free", "s", "m", 1_000 + OLLAMA_VERDICT_TTL_MS)).toBeUndefined();
  });

  it("scopes by plan — the same model under another plan has no verdict", () => {
    const store = emptyOllamaVerdicts();
    setVerdict(store, "free", "s", "m", "gated", 1_000);
    expect(verdictFor(store, "pro", "s", "m", 1_000)).toBeUndefined();
  });

  it("scopes by key hash — another key starts a fresh map", () => {
    const store = emptyOllamaVerdicts();
    setVerdict(store, "free", "s-1", "m", "gated", 1_000);
    expect(verdictFor(store, "free", "s-2", "m", 1_000)).toBeUndefined();
  });

  it("overwrites a previous verdict", () => {
    const store = emptyOllamaVerdicts();
    setVerdict(store, "free", "s", "m", "gated", 1_000);
    setVerdict(store, "free", "s", "m", "ok", 5_000);
    expect(verdictFor(store, "free", "s", "m", 5_000)).toEqual({ result: "ok", at: 5_000 });
  });
});

describe("partitionByVerdicts", () => {
  it("splits fresh-cached from never-mapped models", () => {
    const store = emptyOllamaVerdicts();
    setVerdict(store, "free", "s", "kimi-k3", "gated", 1_000);
    setVerdict(store, "free", "s", "gpt-oss:20b", "ok", 1_000);
    const { known, unknown } = partitionByVerdicts(
      ["kimi-k3", "gpt-oss:20b", "new-model"],
      store,
      "free",
      "s",
      2_000,
    );
    expect([...known.keys()].sort()).toEqual(["gpt-oss:20b", "kimi-k3"]);
    expect(unknown).toEqual(["new-model"]);
  });

  it("sends stale entries back for re-probing", () => {
    const store = emptyOllamaVerdicts();
    setVerdict(store, "free", "s", "m", "ok", 1_000);
    const { known, unknown } = partitionByVerdicts(
      ["m"],
      store,
      "free",
      "s",
      1_000 + OLLAMA_VERDICT_TTL_MS,
    );
    expect(known.size).toBe(0);
    expect(unknown).toEqual(["m"]);
  });

  it("treats every model as unknown under a different plan", () => {
    const store = emptyOllamaVerdicts();
    setVerdict(store, "free", "s", "m", "gated", 1_000);
    const { known, unknown } = partitionByVerdicts(["m"], store, "pro", "s", 2_000);
    expect(known.size).toBe(0);
    expect(unknown).toEqual(["m"]);
  });
});

describe("ollamaVerdictsPath", () => {
  it("resolves under the reasonix home", () => {
    expect(ollamaVerdictsPath("/home/u/.reasonix")).toBe(
      join("/home/u/.reasonix", "ollama-model-map.json"),
    );
  });
});
