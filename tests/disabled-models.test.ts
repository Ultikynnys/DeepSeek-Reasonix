import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadDisabledModels, readConfig, saveDisabledModels } from "../src/config.js";

describe("disabledModels — global persistent model hide list", () => {
  let dir: string;
  let path: string;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "reasonix-disabled-models-"));
    path = join(dir, "config.json");
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
    rmSync(dir, { recursive: true, force: true });
  });

  it("sanitizes disabledModels[] like mcpDisabled[]", () => {
    writeFileSync(path, JSON.stringify({ disabledModels: ["a", { x: 1 }, "b"] }));
    expect(readConfig(path).disabledModels).toEqual(["a", "b"]);
  });

  it("loadDisabledModels defaults to [] when unset", () => {
    writeFileSync(path, JSON.stringify({}));
    expect(loadDisabledModels(path)).toEqual([]);
  });

  it("loadDisabledModels dedupes and trims", () => {
    writeFileSync(path, JSON.stringify({ disabledModels: [" a ", "a", "b", " "] }));
    expect(loadDisabledModels(path)).toEqual(["a", "b"]);
  });

  it("saveDisabledModels persists a deduped list", () => {
    writeFileSync(path, JSON.stringify({}));
    saveDisabledModels(["glm-4.5", " glm-4.5 ", "gpt-5.6-sol"], path);
    expect(loadDisabledModels(path)).toEqual(["glm-4.5", "gpt-5.6-sol"]);
    expect(readConfig(path).disabledModels).toEqual(["glm-4.5", "gpt-5.6-sol"]);
  });

  it("saveDisabledModels clears the field when empty", () => {
    writeFileSync(path, JSON.stringify({ disabledModels: ["a"] }));
    saveDisabledModels([], path);
    expect(loadDisabledModels(path)).toEqual([]);
    expect(readConfig(path).disabledModels).toBeUndefined();
  });
});
