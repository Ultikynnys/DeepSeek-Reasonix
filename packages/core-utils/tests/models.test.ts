import { describe, expect, it } from "vitest";
import {
  ANTIGRAVITY_MODELS,
  GEMINI_MODELS,
  GPT56_MODELS,
  KNOWN_MODELS,
  MODEL_DISPLAY_NAMES,
  SUPPORTED_OFFICIAL_MODELS,
  ZAI_MODELS,
  modelAcceptsImages,
  modelDisplayName,
} from "../src/models.js";

describe("modelAcceptsImages", () => {
  it("accepts the GPT-5.6 family", () => {
    expect(modelAcceptsImages("gpt-5.6-sol")).toBe(true);
    expect(modelAcceptsImages("gpt-5.6-terra")).toBe(true);
    expect(modelAcceptsImages("gpt-5.6-luna")).toBe(true);
  });

  it("accepts DeepSeek and Z.AI vision models", () => {
    expect(modelAcceptsImages("deepseek-v4-flash-vision-exp")).toBe(true);
    expect(modelAcceptsImages("glm-5.3-flash")).toBe(true);
    expect(modelAcceptsImages("glm-4.6v")).toBe(true);
    expect(modelAcceptsImages("glm-5.3")).toBe(false);
  });

  it("accepts every Antigravity model exposed by the unified gateway", () => {
    for (const model of ANTIGRAVITY_MODELS) {
      expect(modelAcceptsImages(model)).toBe(true);
    }
  });

  it("recognizes live Antigravity model ids and rejects internal chat/tab IDs", async () => {
    const { isAntigravityModel } = await import("../src/models.js");
    expect(isAntigravityModel("gemini-3.7-flash")).toBe(true);
    expect(isAntigravityModel("gemini-3.7-flash-tiered")).toBe(true);
    expect(isAntigravityModel("gemini-3.8-flash")).toBe(true);
    expect(isAntigravityModel("gemini-3.8-flash-tiered")).toBe(true);
    expect(isAntigravityModel("claude-sonnet-4-6")).toBe(true);
    expect(isAntigravityModel("gpt-oss-120b-medium")).toBe(true);
    expect(isAntigravityModel("chat_20706")).toBe(false);
    expect(isAntigravityModel("tab_flash_lite_preview")).toBe(false);
  });

  it("rejects plain DeepSeek, Ollama, and unknown ids", () => {
    expect(modelAcceptsImages("deepseek-v4-flash")).toBe(false);
    expect(modelAcceptsImages("deepseek-v4-pro")).toBe(false);
    expect(modelAcceptsImages("ollama/llama3.1:latest")).toBe(false);
    expect(modelAcceptsImages("made-up")).toBe(false);
  });

  it("rejects null / undefined", () => {
    expect(modelAcceptsImages(null)).toBe(false);
    expect(modelAcceptsImages(undefined)).toBe(false);
  });

  it("accepts an Ollama model confirmed vision-capable", () => {
    const vision = new Set(["ollama/llava", "ollama/qwen2.5-vl"]);
    expect(modelAcceptsImages("ollama/llava", vision)).toBe(true);
    expect(modelAcceptsImages("ollama/qwen2.5-vl", vision)).toBe(true);
  });

  it("rejects an Ollama model not in the vision set", () => {
    const vision = new Set(["ollama/llava"]);
    expect(modelAcceptsImages("ollama/llama3.1:latest", vision)).toBe(false);
  });

  it("treats Ollama models as non-vision when the set is omitted", () => {
    expect(modelAcceptsImages("ollama/llava")).toBe(false);
    expect(modelAcceptsImages("ollama/llava", undefined)).toBe(false);
    expect(modelAcceptsImages("ollama/llava", null)).toBe(false);
  });

  it("ignores the Ollama vision set for non-Ollama ids", () => {
    const vision = new Set(["ollama/llava", "gpt-5.6-sol"]);
    expect(modelAcceptsImages("gpt-5.6-sol", vision)).toBe(true);
    expect(modelAcceptsImages("deepseek-v4-flash-vision-exp", vision)).toBe(true);
  });
});

describe("KNOWN_MODELS", () => {
  it("offers DeepSeek's official line including the vision model", () => {
    expect(KNOWN_MODELS).toContain("deepseek-v4-flash");
    expect(KNOWN_MODELS).toContain("deepseek-v4-pro");
    expect(KNOWN_MODELS).toContain("deepseek-v4-flash-vision-exp");
  });

  it("offers the GPT-5.6 family", () => {
    expect(KNOWN_MODELS).toContain("gpt-5.6-sol");
    expect(KNOWN_MODELS).toContain("gpt-5.6-terra");
    expect(KNOWN_MODELS).toContain("gpt-5.6-luna");
  });

  it("offers every Gemini model available through Antigravity", () => {
    expect(GEMINI_MODELS.length).toBeGreaterThan(0);
    for (const model of GEMINI_MODELS) expect(KNOWN_MODELS).toContain(model);
  });

  it("is exactly the combined built-in provider catalog", () => {
    expect(KNOWN_MODELS).toEqual([
      ...SUPPORTED_OFFICIAL_MODELS,
      ...GPT56_MODELS,
      ...ZAI_MODELS,
      ...ANTIGRAVITY_MODELS,
    ]);
  });
});

describe("modelDisplayName", () => {
  it("maps gemini-pro-agent to gemini-3.5-pro", () => {
    expect(modelDisplayName("gemini-pro-agent")).toBe("gemini-3.5-pro");
    expect(MODEL_DISPLAY_NAMES["gemini-pro-agent"]).toBe("gemini-3.5-pro");
  });

  it("falls back to the raw model ID when unmapped", () => {
    expect(modelDisplayName("deepseek-v4-flash")).toBe("deepseek-v4-flash");
    expect(modelDisplayName("gemini-3.7-flash-tiered")).toBe("gemini-3.7-flash-tiered");
    expect(modelDisplayName("gpt-5.6-sol")).toBe("gpt-5.6-sol");
  });

  it("handles null, undefined, and empty string gracefully", () => {
    expect(modelDisplayName(null)).toBe("");
    expect(modelDisplayName(undefined)).toBe("");
    expect(modelDisplayName("")).toBe("");
  });
});
