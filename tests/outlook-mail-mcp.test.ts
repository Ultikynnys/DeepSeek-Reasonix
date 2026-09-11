import { describe, expect, it, vi } from "vitest";
import { isManagedMcpSpec } from "../src/cli/commands/desktop.js";
import { PauseGate } from "../src/core/pause-gate.js";
import {
  OUTLOOK_MAIL_ARGS,
  OUTLOOK_MAIL_CONFIRMED_SEND_TOOLS,
  OUTLOOK_MAIL_DEFAULT_DISABLED_TOOLS,
  OUTLOOK_MAIL_INTERNAL_TOOLS,
  confirmOutlookSend,
  extractOutlookMessageId,
  isOutlookConfirmedSendTool,
  isOutlookMailSpec,
  isOutlookSendCapableTool,
  isTrustedMicrosoftLoginUrl,
  parseOutlookDeviceCode,
  parseOutlookDraftMessage,
  parseOutlookLoginStatus,
  parseOutlookSendArgs,
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

  it("recognizes confirmed send tools", () => {
    expect(isOutlookConfirmedSendTool("send-mail")).toBe(true);
    expect(isOutlookConfirmedSendTool("send-draft-message")).toBe(true);
    expect(isOutlookConfirmedSendTool("reply-mail-message")).toBe(false);
    expect(isOutlookConfirmedSendTool("forward-mail-message")).toBe(false);
    expect(isOutlookConfirmedSendTool("list-mail-messages")).toBe(false);
    expect([...OUTLOOK_MAIL_CONFIRMED_SEND_TOOLS].sort()).toEqual([
      "send-draft-message",
      "send-mail",
    ]);
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

  it("lists all folder and rule administrative tools in OUTLOOK_MAIL_DEFAULT_DISABLED_TOOLS", () => {
    expect([...OUTLOOK_MAIL_DEFAULT_DISABLED_TOOLS].sort()).toEqual([
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
    ]);
  });

  it("requires immutable user confirmation before send-draft-message dispatch", async () => {
    const gate = new PauseGate();
    const callTool = vi.fn(async (tool: string, args: Record<string, unknown>) => {
      if (tool === "verify-login") {
        return {
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
        };
      }
      if (tool === "get-mail-message") {
        expect(args.messageId).toBe("draft-123");
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                id: "draft-123",
                subject: "Draft Subject",
                body: { contentType: "Text", content: "Draft Body Content" },
                toRecipients: [{ emailAddress: { address: "draft-to@example.com" } }],
                ccRecipients: [{ emailAddress: { address: "draft-cc@example.com" } }],
                bccRecipients: [],
                hasAttachments: true,
                attachments: [{ name: "attachment.pdf" }],
              }),
            },
          ],
        };
      }
      throw new Error(`unexpected tool call: ${tool}`);
    });

    let preview: unknown;
    gate.on((request) => {
      preview = request.payload;
      gate.resolve(request.id, { type: "run_once" });
    });

    const result = await confirmOutlookSend({
      toolName: "send-draft-message",
      args: { messageId: "draft-123" },
      client: { callTool } as never,
      gate,
    });

    expect(result).toBeNull();
    expect(preview).toEqual({
      toolName: "send-draft-message",
      from: "sender@outlook.com",
      to: ["draft-to@example.com"],
      cc: ["draft-cc@example.com"],
      bcc: [],
      subject: "Draft Subject",
      body: "Draft Body Content",
      attachments: ["attachment.pdf"],
    });
    expect(callTool).toHaveBeenCalledWith("verify-login", {});
  });

  it("falls back to list-mail-attachments when draft hasAttachments is true but attachments array is unexpanded", async () => {
    const gate = new PauseGate();
    const callTool = vi.fn(async (tool: string, args: Record<string, unknown>) => {
      if (tool === "verify-login") {
        return {
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
        };
      }
      if (tool === "get-mail-message") {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                id: "draft-456",
                subject: "Draft With Attachments",
                body: { content: "Draft body" },
                toRecipients: [{ emailAddress: { address: "to@example.com" } }],
                hasAttachments: true,
              }),
            },
          ],
        };
      }
      if (tool === "list-mail-attachments") {
        expect(args.messageId).toBe("draft-456");
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                value: [{ name: "resume.pdf" }, { name: "portfolio.zip" }],
              }),
            },
          ],
        };
      }
      throw new Error(`unexpected tool call: ${tool}`);
    });

    let preview: unknown;
    gate.on((request) => {
      preview = request.payload;
      gate.resolve(request.id, { type: "run_once" });
    });

    const result = await confirmOutlookSend({
      toolName: "send-draft-message",
      args: { messageId: "draft-456" },
      client: { callTool } as never,
      gate,
    });

    expect(result).toBeNull();
    expect(preview).toMatchObject({
      attachments: ["resume.pdf", "portfolio.zip"],
    });
  });

  it("blocks send-draft-message when messageId is missing or draft cannot be found", async () => {
    const gate = new PauseGate();
    const client = {
      callTool: vi.fn(async (tool: string) => {
        if (tool === "verify-login") {
          return {
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
          };
        }
        throw new Error("404 Not Found");
      }),
    };

    const noId = await confirmOutlookSend({
      toolName: "send-draft-message",
      args: {},
      client: client as never,
      gate,
    });
    expect(noId).toContain("incomplete-email-preview");

    const notFound = await confirmOutlookSend({
      toolName: "send-draft-message",
      args: { messageId: "missing-id" },
      client: client as never,
      gate,
    });
    expect(notFound).toContain("draft-not-found");
  });

  it("blocks unconfirmed send-capable tools fail-closed", async () => {
    const gate = new PauseGate();
    const client = { callTool: vi.fn() };

    const replyBlocked = await confirmOutlookSend({
      toolName: "reply-mail-message",
      args: { messageId: "123", comment: "reply" },
      client: client as never,
      gate,
    });
    expect(replyBlocked).toContain("unsupported-send-tool");

    const forwardBlocked = await confirmOutlookSend({
      toolName: "forward-mail-message",
      args: { messageId: "123", comment: "fwd" },
      client: client as never,
      gate,
    });
    expect(forwardBlocked).toContain("unsupported-send-tool");
  });

  it("extracts messageId from various parameter shapes", () => {
    expect(extractOutlookMessageId({ messageId: "id-1" })).toBe("id-1");
    expect(extractOutlookMessageId({ "message-id": "id-2" })).toBe("id-2");
    expect(extractOutlookMessageId({ id: "id-3" })).toBe("id-3");
    expect(extractOutlookMessageId({ body: { messageId: "id-4" } })).toBe("id-4");
    expect(extractOutlookMessageId({})).toBeNull();
  });

  it("parses send-mail args with PascalCase or direct string bodies", () => {
    const parsed = parseOutlookSendArgs("send-mail", {
      Message: {
        Subject: "Hello",
        Body: "Direct string body",
        ToRecipients: [{ emailAddress: { address: "test@example.com" } }],
        Attachments: [{ Name: "file.txt" }],
      },
    });
    expect(parsed).toEqual({
      toolName: "send-mail",
      to: ["test@example.com"],
      cc: [],
      bcc: [],
      subject: "Hello",
      body: "Direct string body",
      attachments: ["file.txt"],
    });
  });
});
