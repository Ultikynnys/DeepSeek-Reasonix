import type { PauseGate } from "../core/pause-gate.js";
import type { McpClient } from "./client.js";
import type { McpServerSpec } from "./spec.js";
import type { CallToolResult, McpContentBlock } from "./types.js";

export const OUTLOOK_MAIL_SERVER_NAME = "outlook_mail";
export const OUTLOOK_MAIL_PACKAGE = "@softeria/ms-365-mcp-server@0.85.0";
/** `--enabled-tools` (not `--preset mail`) also enables `get-current-user`, whose
 *  `User.Read` scope the server's `verify-login` (GET /me) needs — without it every
 *  login reports 403 and sends are blocked. */
export const OUTLOOK_MAIL_ARGS = [
  "-y",
  OUTLOOK_MAIL_PACKAGE,
  "--enabled-tools",
  "mail|attachment|draft|get-current-user",
] as const;

/** Authentication and account mutation stay under explicit desktop-user control. */
export const OUTLOOK_MAIL_INTERNAL_TOOLS = new Set([
  "login",
  "verify-login",
  "logout",
  "list-accounts",
  "select-account",
  "remove-account",
  // Enabled only so the server requests the User.Read scope verify-login needs;
  // not a mail operation, so keep it off the model surface.
  "get-current-user",
  // These can send without carrying the complete final message in their arguments.
  // Keep them unavailable until Reasonix can fetch and bind an immutable preview.
  "send-draft-message",
  "reply-mail-message",
  "reply-all-mail-message",
  "forward-mail-message",
  // Generic Graph calls could bypass the dedicated send-mail confirmation gate.
  "graph-batch",
]);

export const OUTLOOK_MAIL_CONFIRMED_SEND_TOOL = "send-mail";

/** Fail-safe classifier for current and future upstream tools that can transmit mail. */
export function isOutlookSendCapableTool(toolName: string): boolean {
  return (
    toolName === "graph-batch" ||
    toolName === "reply-mail-message" ||
    toolName === "reply-all-mail-message" ||
    toolName === "forward-mail-message" ||
    /(^|-)send($|-)/.test(toolName)
  );
}

export function isOutlookMailSpec(spec: McpServerSpec): boolean {
  if (spec.transport !== "stdio" || spec.name !== OUTLOOK_MAIL_SERVER_NAME) return false;
  return spec.args.some((arg) => /^@softeria\/ms-365-mcp-server(?:@[A-Za-z0-9._-]+)?$/.test(arg));
}

export function managedMcpToolsHiddenFromModel(spec: McpServerSpec): ReadonlySet<string> {
  return isOutlookMailSpec(spec) ? OUTLOOK_MAIL_INTERNAL_TOOLS : new Set<string>();
}

interface MailAddress {
  emailAddress?: { address?: unknown };
}

function addressList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => (entry as MailAddress)?.emailAddress?.address)
    .filter((address): address is string => typeof address === "string" && address.length > 0);
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

export interface OutlookSendPreview {
  toolName: string;
  from: string;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  body: string;
  attachments: string[];
}

export function parseOutlookSendArgs(
  toolName: string,
  args: Record<string, unknown>,
): Omit<OutlookSendPreview, "from"> | null {
  if (toolName !== OUTLOOK_MAIL_CONFIRMED_SEND_TOOL) return null;
  const requestBody = record(args.body) ?? args;
  const message = record(requestBody.message ?? requestBody.Message ?? requestBody);
  if (!message) return null;
  const body = record(message.body)?.content;
  const attachments = Array.isArray(message.attachments)
    ? message.attachments
        .map((attachment) => record(attachment)?.name)
        .filter((name): name is string => typeof name === "string" && name.length > 0)
    : [];
  return {
    toolName,
    to: addressList(message.toRecipients),
    cc: addressList(message.ccRecipients),
    bcc: addressList(message.bccRecipients),
    subject: typeof message.subject === "string" ? message.subject : "",
    body: typeof body === "string" ? body : "",
    attachments,
  };
}

export async function confirmOutlookSend(opts: {
  toolName: string;
  args: Record<string, unknown>;
  client: McpClient;
  gate?: PauseGate;
}): Promise<string | null> {
  const partial = parseOutlookSendArgs(opts.toolName, opts.args);
  if (!partial) return null;
  if (!opts.gate) {
    return JSON.stringify({
      error: "Outlook email send blocked: no interactive confirmation gate is available.",
      rejectedReason: "confirmation-unavailable",
    });
  }
  if (partial.to.length === 0 || !partial.subject || !partial.body) {
    return JSON.stringify({
      error:
        "Outlook email send blocked: a complete preview requires at least one To recipient, subject, and body.",
      rejectedReason: "incomplete-email-preview",
    });
  }
  const login = parseOutlookLoginStatus(await opts.client.callTool("verify-login", {}));
  if (!login.success || !login.account) {
    return JSON.stringify({
      error: "Outlook email send blocked: the authenticated From address could not be verified.",
      rejectedReason: "sender-unverified",
    });
  }
  const verdict = await opts.gate.ask({
    kind: "outlook_send",
    payload: { ...partial, from: login.account },
  });
  if (verdict.type !== "run_once") {
    return JSON.stringify({
      error: "Outlook email send cancelled by the user. Nothing was sent.",
      rejectedReason: "user-denied",
    });
  }
  return null;
}

export function mcpTextResult(result: CallToolResult): string {
  return result.content
    .filter((block): block is Extract<McpContentBlock, { type: "text" }> => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

export interface OutlookLoginStatus {
  success: boolean;
  message: string;
  account?: string;
}

export function parseOutlookLoginStatus(result: CallToolResult | string): OutlookLoginStatus {
  const text = (typeof result === "string" ? result : mcpTextResult(result)).trim();
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return { success: false, message: text || "Microsoft sign-in returned an empty response" };
  }
  const userData =
    parsed.userData && typeof parsed.userData === "object"
      ? (parsed.userData as Record<string, unknown>)
      : undefined;
  const account =
    typeof userData?.userPrincipalName === "string" ? userData.userPrincipalName : undefined;
  return {
    success: parsed.success === true,
    message:
      typeof parsed.message === "string"
        ? parsed.message
        : typeof parsed.error === "string"
          ? parsed.error
          : "Microsoft sign-in status unavailable",
    ...(account ? { account } : {}),
  };
}

export interface OutlookDeviceCode {
  verificationUrl: string;
  userCode?: string;
  message: string;
}

const MICROSOFT_LOGIN_HOSTS = new Set([
  "microsoft.com",
  "www.microsoft.com",
  "login.microsoftonline.com",
]);

export function isTrustedMicrosoftLoginUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    return url.protocol === "https:" && MICROSOFT_LOGIN_HOSTS.has(url.hostname.toLowerCase());
  } catch {
    return false;
  }
}

export function parseOutlookDeviceCode(result: CallToolResult | string): OutlookDeviceCode | null {
  const text = (typeof result === "string" ? result : mcpTextResult(result)).trim();
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (parsed.error !== "device_code_required" || typeof parsed.message !== "string") return null;
  const message = parsed.message.trim();
  const url = message.match(/https:\/\/[^\s)]+/i)?.[0]?.replace(/[.,;]+$/, "");
  if (!url || !isTrustedMicrosoftLoginUrl(url)) return null;
  const explicitCode = message.match(/\bcode\s+(?:is\s+)?([A-Z0-9]{4,}(?:-[A-Z0-9]+)*)/i)?.[1];
  return {
    verificationUrl: url,
    ...(explicitCode ? { userCode: explicitCode.toUpperCase() } : {}),
    message,
  };
}
