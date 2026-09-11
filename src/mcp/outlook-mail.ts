import { messageOf } from "@reasonix/core-utils";
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
  "reply-mail-message",
  "reply-all-mail-message",
  "forward-mail-message",
  // Generic Graph calls could bypass the dedicated send-mail confirmation gate.
  "graph-batch",
]);

export const OUTLOOK_MAIL_CONFIRMED_SEND_TOOL = "send-mail";
export const OUTLOOK_MAIL_CONFIRMED_SEND_TOOLS = new Set(["send-mail", "send-draft-message"]);

export function isOutlookConfirmedSendTool(toolName: string): boolean {
  return OUTLOOK_MAIL_CONFIRMED_SEND_TOOLS.has(toolName);
}

/** Administrative folder, inbox-rule, and mailbox-configuration tools disabled by default.
 *  Kept off the model surface unless the user explicitly enables them in Settings → MCP. */
export const OUTLOOK_MAIL_DEFAULT_DISABLED_TOOLS: readonly string[] = [
  "create-mail-child-folder",
  "create-mail-folder",
  "create-mail-rule",
  "delete-mail-folder",
  "delete-mail-rule",
  "list-mail-child-folders",
  "list-mail-rules",
  "update-mail-folder",
  "update-mail-rule",
  "update-mailbox-settings",
];

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
  EmailAddress?: { Address?: unknown };
  address?: unknown;
  Address?: unknown;
}

function addressList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => {
      if (typeof entry === "string" && entry.length > 0) return entry;
      const m = entry as MailAddress;
      const addr = m?.emailAddress?.address ?? m?.EmailAddress?.Address ?? m?.address ?? m?.Address;
      return typeof addr === "string" && addr.length > 0 ? addr : null;
    })
    .filter((address): address is string => Boolean(address));
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
  if (toolName !== "send-mail") return null;
  const requestBody = record(args.body) ?? record(args.Body) ?? args;
  const message = record(
    requestBody.message ?? requestBody.Message ?? args.message ?? args.Message ?? requestBody,
  );
  if (!message) return null;
  const bodyField = message.body ?? message.Body;
  const bodyContent =
    typeof bodyField === "string"
      ? bodyField
      : (record(bodyField)?.content ?? record(bodyField)?.Content);
  const subject = message.subject ?? message.Subject;
  const rawAttachments = message.attachments ?? message.Attachments;
  const attachments = Array.isArray(rawAttachments)
    ? rawAttachments
        .map((attachment) => record(attachment)?.name ?? record(attachment)?.Name)
        .filter((name): name is string => typeof name === "string" && name.length > 0)
    : [];
  return {
    toolName,
    to: addressList(message.toRecipients ?? message.ToRecipients),
    cc: addressList(message.ccRecipients ?? message.CcRecipients),
    bcc: addressList(message.bccRecipients ?? message.BccRecipients),
    subject: typeof subject === "string" ? subject : "",
    body: typeof bodyContent === "string" ? bodyContent : "",
    attachments,
  };
}

export function extractOutlookMessageId(args: Record<string, unknown>): string | null {
  const body = record(args.body) ?? record(args.Body);
  const candidate =
    args.messageId ??
    args.MessageId ??
    args["message-id"] ??
    args.id ??
    args.Id ??
    body?.messageId ??
    body?.MessageId ??
    body?.["message-id"] ??
    body?.id ??
    body?.Id;
  return typeof candidate === "string" && candidate.trim().length > 0 ? candidate.trim() : null;
}

export function parseOutlookDraftMessage(
  toolName: string,
  draft: Record<string, unknown>,
): Omit<OutlookSendPreview, "from"> {
  const bodyField = draft.body ?? draft.Body;
  const bodyContent =
    typeof bodyField === "string"
      ? bodyField
      : (record(bodyField)?.content ??
        record(bodyField)?.Content ??
        draft.bodyPreview ??
        draft.BodyPreview ??
        "");
  const subject = draft.subject ?? draft.Subject;
  const rawAttachments = draft.attachments ?? draft.Attachments;
  const attachments = Array.isArray(rawAttachments)
    ? rawAttachments
        .map((att) => record(att)?.name ?? record(att)?.Name)
        .filter((name): name is string => typeof name === "string" && name.length > 0)
    : [];

  return {
    toolName,
    to: addressList(draft.toRecipients ?? draft.ToRecipients),
    cc: addressList(draft.ccRecipients ?? draft.CcRecipients),
    bcc: addressList(draft.bccRecipients ?? draft.BccRecipients),
    subject:
      typeof subject === "string"
        ? subject
        : typeof draft.Subject === "string"
          ? draft.Subject
          : "",
    body: typeof bodyContent === "string" ? bodyContent : "",
    attachments,
  };
}

export async function confirmOutlookSend(opts: {
  toolName: string;
  args: Record<string, unknown>;
  client: McpClient;
  gate?: PauseGate;
}): Promise<string | null> {
  if (!isOutlookSendCapableTool(opts.toolName)) return null;

  if (!isOutlookConfirmedSendTool(opts.toolName)) {
    return JSON.stringify({
      error: `Outlook email operation blocked: ${opts.toolName} cannot be safely confirmed. Use send-mail or create a draft and send with send-draft-message.`,
      rejectedReason: "unsupported-send-tool",
    });
  }

  if (!opts.gate) {
    return JSON.stringify({
      error: "Outlook email send blocked: no interactive confirmation gate is available.",
      rejectedReason: "confirmation-unavailable",
    });
  }

  let partial: Omit<OutlookSendPreview, "from"> | null = null;

  if (opts.toolName === "send-mail") {
    partial = parseOutlookSendArgs(opts.toolName, opts.args);
  } else if (opts.toolName === "send-draft-message") {
    const messageId = extractOutlookMessageId(opts.args);
    if (!messageId) {
      return JSON.stringify({
        error: "Outlook email send blocked: messageId is required to send a draft.",
        rejectedReason: "incomplete-email-preview",
      });
    }

    try {
      let draftResult: CallToolResult;
      try {
        draftResult = await opts.client.callTool("get-mail-message", {
          messageId,
          expand: ["attachments"],
        });
      } catch {
        draftResult = await opts.client.callTool("get-mail-message", { messageId });
      }
      const draftText = mcpTextResult(draftResult).trim();
      const draft = JSON.parse(draftText) as Record<string, unknown>;
      if (draft.error) {
        return JSON.stringify({
          error: `Outlook email send blocked: draft message could not be loaded (${String(draft.error)}).`,
          rejectedReason: "draft-not-found",
        });
      }
      partial = parseOutlookDraftMessage(opts.toolName, draft);
      if (
        partial.attachments.length === 0 &&
        (draft.hasAttachments === true || draft.HasAttachments === true)
      ) {
        try {
          const attResult = await opts.client.callTool("list-mail-attachments", { messageId });
          const attText = mcpTextResult(attResult).trim();
          const parsedAtt = JSON.parse(attText) as Record<string, unknown>;
          const items = Array.isArray(parsedAtt)
            ? parsedAtt
            : Array.isArray(parsedAtt?.value)
              ? (parsedAtt.value as unknown[])
              : [];
          const names = items
            .map((att) => record(att)?.name ?? record(att)?.Name)
            .filter((name): name is string => typeof name === "string" && name.length > 0);
          if (names.length > 0) {
            partial.attachments = names;
          }
        } catch {
          // Non-fatal: if attachment listing fails, still proceed with draft's existing attachments
        }
      }
    } catch (err) {
      return JSON.stringify({
        error: `Outlook email send blocked: failed to inspect draft message before sending (${messageOf(err)}).`,
        rejectedReason: "draft-not-found",
      });
    }
  }

  if (!partial) {
    return JSON.stringify({
      error: "Outlook email send blocked: could not parse email preview.",
      rejectedReason: "incomplete-email-preview",
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
