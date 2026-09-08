import { describe, expect, it } from "vitest";
import { MODEL_CATALOG_GROUP_LABELS, deriveModelCatalog } from "./model-catalog";

describe("deriveModelCatalog", () => {
  it("keeps every group label in the shared catalog definition", () => {
    expect(Object.keys(MODEL_CATALOG_GROUP_LABELS).sort()).toEqual([
      "antigravity",
      "custom",
      "deepseek",
      "openai",
      "opencode",
      "zai",
    ]);
  });

  it("centralizes discovered catalogs and custom membership", () => {
    const catalog = deriveModelCatalog({
      discoveredAntigravityModels: ["gemini-account-model", "chat_internal"],
      customModels: ["gpt-4o-custom", "claude-sonnet-4-6"],
      opencodeModels: ["dynamic-free"],
      includeAntigravity: true,
    });

    expect(catalog.groups.find((group) => group.key === "opencode")?.models).toEqual([
      "dynamic-free",
    ]);
    expect(catalog.antigravityModelIds).toContain("gemini-account-model");
    expect(catalog.antigravityModelIds).not.toContain("chat_internal");
    expect(catalog.customModelIds).toEqual(["gpt-4o-custom"]);
  });

  it("uses dynamic OpenCode vision evidence", () => {
    const catalog = deriveModelCatalog({
      opencodeModels: ["dynamic-vision-free"],
      opencodeVisionModels: new Set(["dynamic-vision-free"]),
    });

    expect(catalog.acceptsImages("dynamic-vision-free")).toBe(true);
    expect(catalog.acceptsImages("unknown-model")).toBe(false);
  });
});
