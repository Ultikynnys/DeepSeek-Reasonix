import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { tabCurrentModelUsable, tabHasCredential } from "../src/cli/commands/desktop.js";

/** Minimal tab stub — the gate functions only read `currentModel`. */
type TabStub = { currentModel: string };

describe("desktop setup gate (#welcome)", () => {
  let tmp: string;
  const realHome = homedir();

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "reasonix-gate-"));
    vi.stubEnv("USERPROFILE", tmp); // Windows
    vi.stubEnv("HOME", tmp); // Unix
    vi.spyOn(require("node:os"), "homedir").mockReturnValue(tmp);
    // Ensure a clean slate — no credentials inherited from the real home.
    // biome-ignore lint/performance/noDelete: undefined leaks as the string "undefined" into some env readers
    delete process.env.DEEPSEEK_API_KEY;
    // biome-ignore lint/performance/noDelete: same reason
    delete process.env.OPENAI_API_KEY;
    // biome-ignore lint/performance/noDelete: same reason
    delete process.env.OLLAMA_BASE_URL;
    // biome-ignore lint/performance/noDelete: same reason
    delete process.env.OLLAMA_API_KEY;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  const deepseekTab: TabStub = { currentModel: "deepseek-v4-flash" };
  const gptTab: TabStub = { currentModel: "gpt-5.6-sol" };
  const ollamaTab: TabStub = { currentModel: "ollama/llama3.1:latest" };

  it("fresh install (no credentials) is gated on every provider", () => {
    // No DeepSeek key, no OpenAI credential, no explicit Ollama endpoint/key.
    expect(tabHasCredential(deepseekTab as never)).toBe(false);
    expect(tabHasCredential(gptTab as never)).toBe(false);
    // With no explicit Ollama endpoint, the default is the cloud URL — which
    // is NOT keyless, so an ollama tab needs an ollamaApiKey too.
    expect(tabHasCredential(ollamaTab as never)).toBe(false);
    expect(tabCurrentModelUsable(ollamaTab as never)).toBe(false);
  });

  it("a DeepSeek key satisfies the DeepSeek tab (readiness + per-turn)", () => {
    writeConfigFor({ apiKey: "sk-deepseek-gate-test-123" });
    expect(tabHasCredential(deepseekTab as never)).toBe(true);
    expect(tabCurrentModelUsable(deepseekTab as never)).toBe(true);
  });

  it("an OpenAI key unblocks a ChatGPT-only install even on the default DeepSeek tab", () => {
    writeConfigFor({ openaiApiKey: "sk-openai-gate-123" });
    // Readiness gate passes (anyProviderConfigured), so the welcome screen clears.
    expect(tabHasCredential(deepseekTab as never)).toBe(true);
    expect(tabHasCredential(gptTab as never)).toBe(true);
    // But the DeepSeek tab itself still can't run a turn without a DeepSeek key.
    expect(tabCurrentModelUsable(deepseekTab as never)).toBe(false);
    expect(tabCurrentModelUsable(gptTab as never)).toBe(true);
  });

  it("an Ollama endpoint unblocks a local-Ollama install on the default DeepSeek tab", () => {
    writeConfigFor({ ollamaBaseUrl: "http://localhost:11434/v1" });
    expect(tabHasCredential(deepseekTab as never)).toBe(true);
    expect(tabHasCredential(ollamaTab as never)).toBe(true);
    // The deepseek tab still needs its own key to run.
    expect(tabCurrentModelUsable(deepseekTab as never)).toBe(false);
    expect(tabCurrentModelUsable(ollamaTab as never)).toBe(true);
  });

  it("a cloud Ollama endpoint without a key is not runnable (per-turn gated)", () => {
    writeConfigFor({ ollamaBaseUrl: "https://ollama.com/v1" });
    // Configuring the endpoint unblocks the welcome screen (anyProviderConfigured)…
    expect(tabHasCredential(ollamaTab as never)).toBe(true);
    // …but a cloud endpoint without ollamaApiKey is NOT keyless — the tab 401s.
    expect(tabCurrentModelUsable(ollamaTab as never)).toBe(false);
  });

  /** Write `~/.reasonix/config.json` inside the stubbed home. */
  function writeConfigFor(cfg: Record<string, unknown>): void {
    const home = join(tmp, ".reasonix");
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "config.json"), JSON.stringify(cfg), "utf8");
  }
});
