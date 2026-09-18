import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  MAX_INLINE_ATTACHMENT_BYTES,
  hydrateOutlookAttachments,
  inferAttachmentContentType,
  looksLikeBase64,
  looksLikeFilePath,
} from "../src/mcp/outlook-attachments.js";
import { bridgeMcpTools } from "../src/mcp/registry.js";
import type { CallToolResult, McpTool } from "../src/mcp/types.js";

const PDF_BYTES = Buffer.from("%PDF-1.4 reasonix attachment test");
const PDF_B64 = PDF_BYTES.toString("base64");

let dir: string;
let pdfPath: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "reasonix-att-"));
  pdfPath = join(dir, "cv.pdf");
  await writeFile(pdfPath, PDF_BYTES);
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

function firstAttachment(args: Record<string, unknown>): Record<string, unknown> {
  const body = args.body as { message: { attachments: Record<string, unknown>[] } };
  return body.message.attachments[0]!;
}

describe("hydrateOutlookAttachments", () => {
  it("inlines a filesystem path dropped into contentBytes (send-mail)", async () => {
    const args = {
      body: {
        message: {
          toRecipients: [{ emailAddress: { address: "a@b.com" } }],
          subject: "s",
          body: { content: "c" },
          attachments: [{ contentBytes: pdfPath }],
        },
      },
    };
    const out = await hydrateOutlookAttachments("send-mail", args);
    const att = firstAttachment(out);
    expect(att.contentBytes).toBe(PDF_B64);
    expect(att.name).toBe("cv.pdf");
    expect(att.contentType).toBe("application/pdf");
    expect(att["@odata.type"]).toBe("#microsoft.graph.fileAttachment");
    // Non-destructive: the caller's args are untouched.
    expect(firstAttachment(args).contentBytes).toBe(pdfPath);
  });

  it("hydrates an explicit path field and keeps a caller-supplied name", async () => {
    const out = await hydrateOutlookAttachments("send-mail", {
      body: { message: { attachments: [{ path: pdfPath, name: "CV_Ubeid.pdf" }] } },
    });
    const att = firstAttachment(out);
    expect(att.name).toBe("CV_Ubeid.pdf");
    expect(att.contentBytes).toBe(PDF_B64);
    expect(att.path).toBeUndefined();
  });

  it("resolves a workspace-relative path", async () => {
    const out = await hydrateOutlookAttachments(
      "send-mail",
      { body: { message: { attachments: [{ path: "cv.pdf" }] } } },
      { workspaceDir: dir },
    );
    expect(firstAttachment(out).contentBytes).toBe(PDF_B64);
  });

  it("hydrates add-mail-attachment's body attachment and preserves messageId", async () => {
    const out = await hydrateOutlookAttachments("add-mail-attachment", {
      messageId: "m1",
      body: { contentBytes: pdfPath },
    });
    expect((out.body as Record<string, unknown>).contentBytes).toBe(PDF_B64);
    expect(out.messageId).toBe("m1");
  });

  it("leaves a real base64 payload untouched (same reference)", async () => {
    const args = {
      body: {
        message: { attachments: [{ contentBytes: PDF_B64, name: "x.pdf" }] },
      },
    };
    expect(await hydrateOutlookAttachments("send-mail", args)).toBe(args);
  });

  it("ignores non-attachment tools", async () => {
    const args = { body: { attachments: [{ contentBytes: pdfPath }] } };
    expect(await hydrateOutlookAttachments("list-mail-messages", args)).toBe(args);
  });

  it("throws a clear error when the file is missing", async () => {
    await expect(
      hydrateOutlookAttachments("send-mail", {
        body: { message: { attachments: [{ path: join(dir, "nope.pdf") }] } },
      }),
    ).rejects.toThrow(/not found/);
  });

  it("refuses files above the inline cap", async () => {
    await expect(
      hydrateOutlookAttachments(
        "send-mail",
        { body: { message: { attachments: [{ path: pdfPath }] } } },
        { maxInlineBytes: 1 },
      ),
    ).rejects.toThrow(/capped at/);
  });

  it("infers content types by extension", () => {
    expect(inferAttachmentContentType("a.PDF")).toBe("application/pdf");
    expect(inferAttachmentContentType("a.zip")).toBe("application/zip");
    expect(inferAttachmentContentType("a.unknown")).toBe("application/octet-stream");
  });

  it("distinguishes paths from base64", () => {
    expect(looksLikeFilePath("C:\\x\\y.pdf")).toBe(true);
    expect(looksLikeFilePath("/home/x/y.pdf")).toBe(true);
    expect(looksLikeFilePath("aGVsbG8=")).toBe(false);
    expect(looksLikeBase64("aGVsbG8=")).toBe(true);
    expect(looksLikeBase64("C:\\x\\y.pdf")).toBe(false);
  });

  it("exposes the 3 MB inline cap", () => {
    expect(MAX_INLINE_ATTACHMENT_BYTES).toBe(3 * 1024 * 1024);
  });
});

function fakeSendMailClient(onCall: (args: Record<string, unknown>) => void) {
  const fake = {
    listTools: async () => ({
      tools: [
        {
          name: "send-mail",
          description: "send",
          inputSchema: { type: "object", properties: {} },
        } as McpTool,
      ],
    }),
    callTool: async (_name: string, args: Record<string, unknown>): Promise<CallToolResult> => {
      onCall(args);
      return { content: [{ type: "text", text: "OK!" }] };
    },
  };
  return fake as unknown as Parameters<typeof bridgeMcpTools>[0];
}

describe("bridge transformArgs hook", () => {
  it("replaces args with the hydrated version before the upstream call", async () => {
    let seen: Record<string, unknown> | undefined;
    const client = fakeSendMailClient((args) => {
      seen = args;
    });
    const { registry } = await bridgeMcpTools(client, {
      transformArgs: (toolName, args) => hydrateOutlookAttachments(toolName, args),
    });
    const out = await registry.dispatch(
      "send-mail",
      JSON.stringify({ body: { message: { attachments: [{ path: pdfPath }] } } }),
    );
    expect(out).toContain("OK!");
    const att = firstAttachment(seen as Record<string, unknown>);
    expect(att.contentBytes).toBe(PDF_B64);
  });

  it("turns a hydration error into a JSON error result without calling upstream", async () => {
    let called = false;
    const client = fakeSendMailClient(() => {
      called = true;
    });
    const { registry } = await bridgeMcpTools(client, {
      transformArgs: (toolName, args) => hydrateOutlookAttachments(toolName, args),
    });
    const out = await registry.dispatch(
      "send-mail",
      JSON.stringify({ body: { message: { attachments: [{ path: join(dir, "missing.pdf") }] } } }),
    );
    expect(out).toContain("not found");
    expect(called).toBe(false);
  });
});
