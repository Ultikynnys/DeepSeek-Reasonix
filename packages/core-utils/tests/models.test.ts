import { describe, expect, it } from "vitest";
import { modelAcceptsImages } from "../src/models.js";

describe("modelAcceptsImages", () => {
  it("accepts the GPT-5.6 family", () => {
    expect(modelAcceptsImages("gpt-5.6-sol")).toBe(true);
    expect(modelAcceptsImages("gpt-5.6-terra")).toBe(true);
    expect(modelAcceptsImages("gpt-5.6-luna")).toBe(true);
  });

  it("accepts DeepSeek's vision line", () => {
    expect(modelAcceptsImages("deepseek-v4-flash-vision-exp")).toBe(true);
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
});
