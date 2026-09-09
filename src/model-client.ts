import { resolveGeminiAuth } from "./antigravity-oauth.js";
import { DeepSeekClient, type DeepSeekClientOptions } from "./client.js";
import { resolveCodexTransport } from "./codex-backend.js";
import {
  DEFAULT_OPENCODE_CHAT_URL,
  isOpenAIStandardEndpoint,
  loadEndpointForModel,
  providerForModel,
} from "./config.js";
import { resolveOpenAIToken } from "./oauth.js";

export interface ResolvedModelClientOptions {
  model: string;
  configPath?: string;
  sessionId?: string;
}

/** Build endpoint-aware client options shared by primary and subagent runtimes. */
export function modelClientOptions(opts: ResolvedModelClientOptions): DeepSeekClientOptions {
  const endpoint = loadEndpointForModel(opts.model, opts.configPath);
  const provider = providerForModel(opts.model, opts.configPath);
  const openAIStandard = isOpenAIStandardEndpoint(opts.model, opts.configPath);

  return {
    apiKey: endpoint.apiKey,
    baseUrl: endpoint.baseUrl,
    sessionId: opts.sessionId,
    allowMissingKey: provider === "ollama" || provider === "opencode",
    apiKeyResolver: openAIStandard ? () => resolveOpenAIToken(opts.configPath) : undefined,
    transportResolver: openAIStandard
      ? () => resolveCodexTransport()
      : provider === "opencode" && opts.model.startsWith("muse-")
        ? async () => ({
            endpoint: `${endpoint.baseUrl ?? DEFAULT_OPENCODE_CHAT_URL}/responses`,
            headers: { Authorization: `Bearer ${endpoint.apiKey ?? "public"}` },
            api: "responses" as const,
          })
        : undefined,
    geminiAuthResolver:
      provider === "gemini" ? () => resolveGeminiAuth(opts.configPath) : undefined,
  };
}

/** Construct a client using the canonical endpoint, auth, and transport policy. */
export function createModelClient(opts: ResolvedModelClientOptions): DeepSeekClient {
  return new DeepSeekClient(modelClientOptions(opts));
}
