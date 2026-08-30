import type { DeepSeekClient } from "../client.js";
import type { ModelProvider } from "../config.js";
import { t } from "../i18n/index.js";
import type { TranslationSchema } from "../i18n/types.js";

export interface DeepSeekProbeResult {
  reachable: boolean;
}

export interface FormatLoopErrorOptions {
  /** Authoritative provider selected from the request model. */
  provider?: ModelProvider;
  /** Compatibility fallback for external callers that do not supply provider. */
  upstreamHost?: string;
}

export function formatLoopError(
  err: Error,
  probe?: DeepSeekProbeResult,
  opts?: FormatLoopErrorOptions,
): string {
  const msg = err.message ?? "";
  const match = /^(DeepSeek|OpenAI|Ollama|Antigravity|Z\.AI|Upstream) (\d{3}):\s*([\s\S]*)$/.exec(
    msg,
  );
  const provider = resolveErrorProvider(opts?.provider, match?.[1], opts?.upstreamHost);
  if (
    match &&
    (msg.includes("maximum context length") || /context window|prompt too long/i.test(msg))
  ) {
    const reqMatch = msg.match(/requested\s+(\d+)\s+tokens/);
    const requested = reqMatch
      ? `${Number(reqMatch[1]).toLocaleString()} tokens`
      : t("errors.contextOverflowTooMany");
    return providerMessage(provider, "context", { requested, inner: msg });
  }
  if (!match) {
    if (/timed out after/i.test(msg)) return providerMessage(provider, "timeout", { inner: msg });
    return msg;
  }

  const status = match[2]!;
  const inner = extractProviderErrorMessage(match[3]!);
  if (status === "400" || status === "413" || status === "422") {
    if (/maximum context length|context window|prompt too long|reduce the length/i.test(inner)) {
      return providerMessage(provider, "context", {
        requested: t("errors.contextOverflowTooMany"),
        inner,
      });
    }
    return providerMessage(provider, "request", { inner });
  }
  if (status === "401") return providerMessage(provider, "auth", { inner });
  if (status === "402") return providerMessage(provider, "credits", { inner });
  if (status === "403") return providerMessage(provider, "permission", { inner });
  if (status === "404") return providerMessage(provider, "notFound", { inner });
  if (status === "408") return providerMessage(provider, "timeout", { inner });
  if (status === "429") {
    const exhausted =
      provider === "deepseek"
        ? /insufficient (?:credits?|balance)|out of credits/i.test(inner)
        : isOutOfCredits429(inner);
    return providerMessage(provider, exhausted ? "credits" : "rate", { inner });
  }
  if (is5xxStatus(status)) {
    if (provider === "deepseek") return formatDeepSeek5xx(status, probe);
    return providerMessage(provider, "server", { inner, status });
  }
  return msg;
}

const PROVIDER_ERROR_PREFIX = "(?:DeepSeek|OpenAI|Ollama|Antigravity|Z\\.AI|Upstream)";

export function is5xxError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return new RegExp(`^${PROVIDER_ERROR_PREFIX} 5\\d{2}:`).test(err.message ?? "");
}

export function is4xxError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return new RegExp(`^${PROVIDER_ERROR_PREFIX} 4\\d{2}:`).test(err.message ?? "");
}

/** Read structured metadata off thrown errors without resorting to `as any`. */
export function errorMeta(err: unknown): {
  code?: string;
  phase?: string;
  partialDelivered?: boolean;
  timedOut?: boolean;
} {
  if (!(err instanceof Error)) return {};
  const code = "code" in err && typeof err.code === "string" ? err.code : undefined;
  const phase = "phase" in err && typeof err.phase === "string" ? err.phase : undefined;
  const partialDelivered = "partialDelivered" in err && err.partialDelivered === true;
  const timedOut = "timedOut" in err && err.timedOut === true;
  return {
    code,
    phase,
    ...(partialDelivered ? { partialDelivered } : {}),
    ...(timedOut ? { timedOut } : {}),
  };
}

export async function probeDeepSeekReachable(
  client: DeepSeekClient,
  timeoutMs = 1500,
): Promise<DeepSeekProbeResult> {
  const balance = await client.getBalance({ signal: AbortSignal.timeout(timeoutMs) });
  return { reachable: balance !== null };
}

/** Allow-list — only api.deepseek.com gets DS-specific 5xx wording + balance probe. */
export function isDeepSeekHost(baseUrl: string | undefined | null): boolean {
  if (!baseUrl) return false;
  try {
    const host = new URL(baseUrl).hostname.toLowerCase();
    return host === "api.deepseek.com";
  } catch {
    return false;
  }
}

type ErrorProvider = ModelProvider | "upstream";
type ErrorKind =
  | "auth"
  | "credits"
  | "permission"
  | "notFound"
  | "request"
  | "context"
  | "timeout"
  | "rate"
  | "server";

const ERROR_KEYS: Record<ErrorProvider, Record<ErrorKind, keyof TranslationSchema["errors"]>> = {
  deepseek: {
    auth: "deepseekAuth",
    credits: "deepseekCredits",
    permission: "deepseekPermission",
    notFound: "deepseekNotFound",
    request: "deepseekRequest",
    context: "deepseekContext",
    timeout: "deepseekTimeout",
    rate: "deepseekRate",
    server: "deepseekServer",
  },
  openai: {
    auth: "openaiAuth",
    credits: "openaiCredits",
    permission: "openaiPermission",
    notFound: "openaiNotFound",
    request: "openaiRequest",
    context: "openaiContext",
    timeout: "openaiTimeout",
    rate: "openaiRate",
    server: "openaiServer",
  },
  ollama: {
    auth: "ollamaAuth",
    credits: "ollamaCredits",
    permission: "ollamaPermission",
    notFound: "ollamaNotFound",
    request: "ollamaRequest",
    context: "ollamaContext",
    timeout: "ollamaTimeout",
    rate: "ollamaRate",
    server: "ollamaServer",
  },
  gemini: {
    auth: "antigravityAuth",
    credits: "antigravityCredits",
    permission: "antigravityPermission",
    notFound: "antigravityNotFound",
    request: "antigravityRequest",
    context: "antigravityContext",
    timeout: "antigravityTimeout",
    rate: "antigravityRate",
    server: "antigravityServer",
  },
  zai: {
    auth: "zaiAuth",
    credits: "zaiCredits",
    permission: "zaiPermission",
    notFound: "zaiNotFound",
    request: "zaiRequest",
    context: "zaiContext",
    timeout: "zaiTimeout",
    rate: "zaiRate",
    server: "zaiServer",
  },
  upstream: {
    auth: "customAuth",
    credits: "customCredits",
    permission: "customPermission",
    notFound: "customNotFound",
    request: "customRequest",
    context: "customContext",
    timeout: "customTimeout",
    rate: "customRate",
    server: "customServer",
  },
};

function providerMessage(
  provider: ErrorProvider,
  kind: ErrorKind,
  vars: Record<string, string>,
): string {
  return t(`errors.${ERROR_KEYS[provider][kind]}`, vars);
}

function resolveErrorProvider(
  configured: ModelProvider | undefined,
  prefix: string | undefined,
  upstreamHost: string | undefined,
): ErrorProvider {
  if (configured) return configured;
  if (prefix === "DeepSeek") return "deepseek";
  if (prefix === "OpenAI") return "openai";
  if (prefix === "Ollama") return "ollama";
  if (prefix === "Antigravity") return "gemini";
  if (prefix === "Z.AI") return "zai";
  if (upstreamHost) {
    try {
      const host = new URL(upstreamHost).hostname.toLowerCase();
      if (host.endsWith("deepseek.com")) return "deepseek";
      if (host.endsWith("openai.com") || host.endsWith("chatgpt.com")) return "openai";
      if (host.endsWith("ollama.com") || host === "localhost" || host === "127.0.0.1") {
        return "ollama";
      }
      if (host.endsWith("googleapis.com")) return "gemini";
      if (host.endsWith("z.ai")) return "zai";
    } catch {
      return "upstream";
    }
  }
  return "upstream";
}

function is5xxStatus(status: string): boolean {
  return status === "500" || status === "502" || status === "503" || status === "504";
}

const OUT_OF_CREDITS_429 =
  /no credits? remaining|insufficient (?:credits?|balance)|out of credits|usage limit|current quota|insufficient_quota|no resource package|resource package|weekly limit|monthly limit|quota exceeded|resource_exhausted/i;

function isOutOfCredits429(inner: string): boolean {
  return OUT_OF_CREDITS_429.test(inner);
}

function formatDeepSeek5xx(status: string, probe?: DeepSeekProbeResult): string {
  const head = t("errors.deepseek5xxHead", { status });
  const probeNote =
    probe === undefined
      ? ""
      : probe.reachable
        ? t("errors.deepseek5xxReachable")
        : t("errors.deepseek5xxUnreachable");
  const action =
    probe?.reachable === false
      ? t("errors.deepseek5xxActionNetwork")
      : t("errors.deepseek5xxActionRetry");
  return `${head}${probeNote}${action}`;
}

export function reasonPrefixFor(reason: "aborted" | "context-guard" | "stuck"): string {
  if (reason === "aborted") return t("errors.reasonAborted");
  if (reason === "context-guard") return t("errors.reasonContextGuard");
  return t("errors.reasonStuck");
}

export function errorLabelFor(reason: "aborted" | "context-guard" | "stuck"): string {
  if (reason === "aborted") return t("errors.labelAborted");
  if (reason === "context-guard") return t("errors.labelContextGuard");
  return t("errors.labelStuck");
}

function extractProviderErrorMessage(body: string): string {
  const trimmed = body.trim();
  if (!trimmed) return t("errors.innerNoMessage");
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && typeof parsed === "object") {
      const obj = parsed as {
        error?: { message?: unknown };
        message?: unknown;
        // FastAPI-style envelope (e.g. the ChatGPT codex backend's
        // {"detail":"Unsupported parameter: messages"}).
        detail?: unknown;
      };
      if (obj.error && typeof obj.error.message === "string") return obj.error.message;
      if (typeof obj.message === "string") return obj.message;
      if (typeof obj.detail === "string") return obj.detail;
    }
  } catch {
    /* not JSON — fall through */
  }
  return trimmed;
}
