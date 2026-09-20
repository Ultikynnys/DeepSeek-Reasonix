import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadEnabledModels, readConfig, saveEnabledModels } from "../src/config.js";

describe("enabledModels — global persistent model allow-list (all off by default)", () => {
  let dir: string;
  let path: string;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "reasonix-enabled-models-"));
    path = join(dir, "config.json");
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
    rmSync(dir, { recursive: true, force: true });
  });

  it("sanitizes enabledModels[] like mcpDisabled[]", () => {
    writeFileSync(path, JSON.stringify({ enabledModels: ["a", { x: 1 }, "b"] }));
    expect(readConfig(path).enabledModels).toEqual(["a", "b"]);
  });

  it("loadEnabledModels defaults to [] when unset — nothing enabled by default", () => {
    writeFileSync(path, JSON.stringify({}));
    expect(loadEnabledModels(path)).toEqual([]);
  });

  it("loadEnabledModels dedupes and trims", () => {
    writeFileSync(path, JSON.stringify({ enabledModels: [" a ", "a", "b", " "] }));
    expect(loadEnabledModels(path)).toEqual(["a", "b"]);
  });

  it("saveEnabledModels persists a deduped allow-list", () => {
    writeFileSync(path, JSON.stringify({}));
    saveEnabledModels(["glm-4.5", " glm-4.5 ", "gpt-5.6-sol"], path);
    expect(loadEnabledModels(path)).toEqual(["glm-4.5", "gpt-5.6-sol"]);
    expect(readConfig(path).enabledModels).toEqual(["glm-4.5", "gpt-5.6-sol"]);
  });

  it("saveEnabledModels clears the field when empty — disabling everything", () => {
    writeFileSync(path, JSON.stringify({ enabledModels: ["a"] }));
    saveEnabledModels([], path);
    expect(loadEnabledModels(path)).toEqual([]);
    expect(readConfig(path).enabledModels).toBeUndefined();
  });

  it("ignores the legacy disabledModels hide-list field", () => {
    writeFileSync(path, JSON.stringify({ disabledModels: ["a", "b"] }));
    expect(loadEnabledModels(path)).toEqual([]);
  });
});
