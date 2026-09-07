import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Usage } from "../src/client.js";
import { appendUsage } from "../src/telemetry/usage.js";

describe("appendUsage provider-aware pricing", () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "reasonix-usage-"));
    path = join(dir, "usage.jsonl");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("persists Ollama Cloud off-peak USD cost from explicit provider context", () => {
    const record = appendUsage({
      session: "test",
      model: "ollama/deepseek-v4-flash",
      usage: new Usage(2_000_000, 1_000_000, 3_000_000, 1_000_000, 1_000_000),
      now: Date.UTC(2026, 8, 5, 13),
      path,
      billingKind: "usd",
      provider: "ollama",
    });
    expect(record).toMatchObject({
      provider: "ollama",
      billingKind: "usd",
      costUsd: 0.887,
    });
  });

  it("persists 2x Ollama Cloud pricing during the weekday peak window", () => {
    const record = appendUsage({
      session: null,
      model: "ollama/deepseek-v4-pro:cloud",
      usage: new Usage(2_000_000, 1_000_000, 3_000_000, 1_000_000, 1_000_000),
      now: Date.UTC(2026, 0, 1, 12),
      path,
      billingKind: "usd",
      provider: "ollama",
    });
    expect(record.costUsd).toBeCloseTo((0.022 + 0.66 + 1.98) * 2, 10);
  });

  it("does not apply Ollama pricing to the same id resolved to another provider", () => {
    const record = appendUsage({
      session: null,
      model: "ollama/deepseek-v4-flash",
      usage: new Usage(1_000_000, 1_000_000, 2_000_000, 0, 1_000_000),
      now: Date.UTC(2026, 0, 1, 13),
      path,
      billingKind: "usd",
      provider: "openai",
    });
    expect(record.costUsd).toBe(0);
  });
});
