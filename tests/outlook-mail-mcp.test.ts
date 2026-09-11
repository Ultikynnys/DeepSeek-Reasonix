import { describe, expect, it, vi } from "vitest";
import { isManagedMcpSpec } from "../src/cli/commands/desktop.js";
import { PauseGate } from "../src/core/pause-gate.js";
import {
  OUTLOOK_MAIL_ARGS,
  OUTLOOK_MAIL_INTERNAL_TOOLS,
  confirmOutlookSend,
  isOutlookMailSpec,
  isOutlookSendCapableTool,
  isTrustedMicrosoftLoginUrl,
  parseOutlookDeviceCode,
  parseOutlookLoginStatus,
} from "../src/mcp/outlook-mail.js";
import { parseMcpSpec } from "../src/mcp/spec.js";

describe("managed Outlook Mail MCP", () => {
  it("recognizes only the managed named Softeria stdio server", () => {
    expect(isOutlookMailSpec(parseMcpSpec(`outlook_mail=npx ${OUTLOOK_MAIL_ARGS.join(" ")}`))).toBe(
      true,
    );
    expect(isOutlookMailSpec(parseMcpSpec(`other=npx ${OUTLOOK_MAIL_ARGS.join(" ")}`))).toBe(false);
    expect(isOutlookMailSpec(parseMcpSpec("outlook_mail=npx -y another-package"))).toBe(false);
  });

  it("classifies Outlook Mail as a managed built-in just like Playwright", () => {
    expect(isManagedMcpSpec(parseMcpSpec(`outlook_mail=npx ${OUTLOOK_MAIL_ARGS.join(" ")}`))).toBe(
      true,
    );
    expect(isManagedMcpSpec(parseMcpSpec("playwright=npx -y @playwright/mcp"))).toBe(true);
    expect(isManagedMcpSpec(parseMcpSpec("custom=npx -y custom-mcp"))).toBe(false);
  });

  it("classifies every direct or indirect send-capable tool fail-safe", () => {
    expect(isOutlookSendCapableTool("send-mail")).toBe(true);
    expect(isOutlookSendCapableTool("send-draft-message")).toBe(true);
    expect(isOutlookSendCapableTool("reply-mail-message")).toBe(true);
    expect(isOutlookSendCapableTool("reply-all-mail-message")).toBe(true);
    expect(isOutlookSendCapableTool("forward-mail-message")).toBe(true);
    expect(isOutlookSendCapableTool("graph-batch")).toBe(true);
    expect(isOutlookSendCapableTool("list-mail-messages")).toBe(false);
  });

  it("keeps authentication and account mutation tools out of the model surface", () => {
    expect([...OUTLOOK_MAIL_INTERNAL_TOOLS].sort()).toEqual([
      "forward-mail-message",
      "get-current-user",
      "graph-batch",
      "list-accounts",
      "login",
      "logout",
      "remove-account",
      "reply-all-mail-message",
      "reply-mail-message",
      "select-account",
      "send-draft-message",
      "verify-login",
    ]);
  });

  it("parses the upstream body wrapper without omitting recipients or content", async () => {
    const gate = new PauseGate();
    let preview: unknown;
    gate.on((request) => {
      preview = request.payload;
      gate.resolve(request.id, { type: "deny" });
    });
    await confirmOutlookSend({
      toolName: "send-mail",
      args: {
        body: {
          message: {
            toRecipients: [{ emailAddress: { address: "recipient@example.com" } }],
            subject: "Wrapped",
            body: { content: "Wrapped body" },
          },
        },
      },
      client: {
        callTool: vi.fn(async () => ({
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                success: true,
                message: "ok",
                userData: { userPrincipalName: "sender@outlook.com" },
              }),
            },
          ],
        })),
      } as never,
      gate,
    });
    expect(preview).toMatchObject({
      to: ["recipient@example.com"],
      subject: "Wrapped",
      body: "Wrapped body",
    });
  });

  it("requires immutable user confirmation before direct send-mail dispatch", async () => {
    const gate = new PauseGate();
    const callTool = vi.fn(async () => ({
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({
            success: true,
            message: "ok",
            userData: { userPrincipalName: "sender@outlook.com" },
          }),
        },
      ],
    }));
    let preview: unknown;
    gate.on((request) => {
      preview = request.payload;
      gate.resolve(request.id, { type: "run_once" });
    });
    const result = await confirmOutlookSend({
      toolName: "send-mail",
      args: {
        message: {
          toRecipients: [{ emailAddress: { address: "recipient@example.com" } }],
          ccRecipients: [{ emailAddress: { address: "copy@example.com" } }],
          bccRecipients: [{ emailAddress: { address: "hidden@example.com" } }],
          subject: "Application",
          body: { contentType: "Text", content: "Complete body" },
          attachments: [{ name: "CV.pdf", contentBytes: "not-shown" }],
        },
      },
      client: { callTool } as never,
      gate,
    });
    expect(result).toBeNull();
    expect(preview).toEqual({
      toolName: "send-mail",
      from: "sender@outlook.com",
      to: ["recipient@example.com"],
      cc: ["copy@example.com"],
      bcc: ["hidden@example.com"],
      subject: "Application",
      body: "Complete body",
      attachments: ["CV.pdf"],
    });
    expect(callTool).toHaveBeenCalledWith("verify-login", {});
  });

  it("fails closed without a gate, verified sender, or complete content", async () => {
    const authenticatedClient = {
      callTool: vi.fn(async () => ({
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              success: true,
              message: "ok",
              userData: { userPrincipalName: "sender@outlook.com" },
            }),
          },
        ],
      })),
    };
    const base = {
      toolName: "send-mail",
      args: {
        message: {
          toRecipients: [{ emailAddress: { address: "recipient@example.com" } }],
          subject: "Application",
          body: { content: "Complete body" },
        },
      },
      client: authenticatedClient as never,
    };
    expect(await confirmOutlookSend(base)).toContain("confirmation-unavailable");
    expect(
      await confirmOutlookSend({
        ...base,
        args: { message: { subject: "Application", body: { content: "Complete body" } } },
        gate: new PauseGate(),
      }),
    ).toContain("incomplete-email-preview");
  });

  it("blocks the send when the user rejects, including under any edit mode", async () => {
    const gate = new PauseGate();
    gate.on((request) => gate.resolve(request.id, { type: "deny" }));
    const result = await confirmOutlookSend({
      toolName: "send-mail",
      args: {
        message: {
          toRecipients: [{ emailAddress: { address: "recipient@example.com" } }],
          subject: "Application",
          body: { content: "Complete body" },
        },
      },
      client: {
        callTool: vi.fn(async () => ({
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                success: true,
                message: "ok",
                userData: { userPrincipalName: "sender@outlook.com" },
              }),
            },
          ],
        })),
      } as never,
      gate,
    });
    expect(result).toContain("user-denied");
  });

  it("parses sanitized connected account status", () => {
    expect(
      parseOutlookLoginStatus(
        JSON.stringify({
          success: true,
          message: "Login successful",
          userData: { displayName: "Ada", userPrincipalName: "ada@outlook.com" },
        }),
      ),
    ).toEqual({ success: true, message: "Login successful", account: "ada@outlook.com" });
  });

  it("extracts the Microsoft verification URL and user code", () => {
    expect(
      parseOutlookDeviceCode(
        JSON.stringify({
          error: "device_code_required",
          message:
            "To sign in, use a web browser to open https://microsoft.com/devicelogin and enter the code ABCD-EFGH to authenticate.",
        }),
      ),
    ).toEqual({
      verificationUrl: "https://microsoft.com/devicelogin",
      userCode: "ABCD-EFGH",
      message:
        "To sign in, use a web browser to open https://microsoft.com/devicelogin and enter the code ABCD-EFGH to authenticate.",
    });
  });

  it("accepts only HTTPS Microsoft login URLs", () => {
    expect(isTrustedMicrosoftLoginUrl("https://microsoft.com/devicelogin")).toBe(true);
    expect(isTrustedMicrosoftLoginUrl("http://microsoft.com/devicelogin")).toBe(false);
    expect(isTrustedMicrosoftLoginUrl("https://microsoft.com.evil.test/devicelogin")).toBe(false);
    expect(
      parseOutlookDeviceCode(
        JSON.stringify({
          error: "device_code_required",
          message: "Open https://evil.test and enter the code ABCD-EFGH",
        }),
      ),
    ).toBeNull();
  });

  it("does not mistake unrelated text for a device-code response", () => {
    expect(parseOutlookDeviceCode(JSON.stringify({ error: "denied", message: "No" }))).toBeNull();
  });
});
