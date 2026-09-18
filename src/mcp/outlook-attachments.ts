import { promises as fs } from "node:fs";
import { basename, extname, isAbsolute, resolve } from "node:path";

/** Outlook tools whose arguments can reference a local file to attach. */
export const OUTLOOK_ATTACHMENT_TOOLS = new Set(["send-mail", "add-mail-attachment"]);

/** Inline attachments must fit the upstream `add-mail-attachment` ceiling (<3MB).
 *  Graph base64-inflates the payload, so larger files take a different (upload
 *  session) path that this hydration deliberately refuses rather than mangle. */
export const MAX_INLINE_ATTACHMENT_BYTES = 3 * 1024 * 1024;

const CONTENT_TYPE_BY_EXT: Record<string, string> = {
  ".pdf": "application/pdf",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".csv": "text/csv",
  ".html": "text/html",
  ".htm": "text/html",
  ".json": "application/json",
  ".xml": "application/xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".ppt": "application/vnd.ms-powerpoint",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".zip": "application/zip",
};

export function inferAttachmentContentType(filePath: string): string {
  return CONTENT_TYPE_BY_EXT[extname(filePath).toLowerCase()] ?? "application/octet-stream";
}

/** Does `value` name a file location (drive/UNC/POSIX/any separator)? */
export function looksLikeFilePath(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0) return false;
  if (value.includes("\n") || value.includes("\r") || value.includes("\0")) return false;
  return /^[A-Za-z]:[\\/]/.test(value) || value.startsWith("\\\\") || /[\\/]/.test(value);
}

/** Canonical base64 (alphabet only, 4-char aligned). Guards against mistaking a
 *  real `contentBytes` base64 blob — which may contain `/` and `+` — for a path. */
export function looksLikeBase64(value: unknown): boolean {
  if (typeof value !== "string" || value.length === 0) return false;
  return /^[A-Za-z0-9+/]+={0,2}$/.test(value) && value.length % 4 === 0;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function pathField(attachment: Record<string, unknown>): string | undefined {
  for (const key of ["path", "filePath", "file_path"] as const) {
    const value = attachment[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  // Agents routinely drop the path straight into `contentBytes` (the exact call
  // that 400s upstream with "Cannot convert the literal '…' to Edm.Binary").
  const contentBytes = attachment.contentBytes ?? attachment.ContentBytes;
  if (looksLikeFilePath(contentBytes) && !looksLikeBase64(contentBytes)) return contentBytes;
  return undefined;
}

/** Resolve a path-referenced attachment into a Graph fileAttachment with inlined
 *  base64 `contentBytes`. Returns the SAME reference when there is nothing to do,
 *  so callers can detect a no-op. Throws a descriptive Error on a bad/oversize file. */
async function hydrateAttachment(
  attachment: Record<string, unknown>,
  workspaceDir: string | undefined,
  maxInlineBytes: number,
): Promise<Record<string, unknown>> {
  const rawPath = pathField(attachment);
  if (!rawPath) return attachment;

  const resolved = isAbsolute(rawPath) ? rawPath : resolve(workspaceDir ?? process.cwd(), rawPath);
  let stat: Awaited<ReturnType<typeof fs.stat>>;
  try {
    stat = await fs.stat(resolved);
  } catch {
    throw new Error(
      `attachment file not found: ${resolved}. Pass an absolute path, or a path relative to the workspace.`,
    );
  }
  if (!stat.isFile()) {
    throw new Error(`attachment path is not a file: ${resolved}.`);
  }
  if (stat.size > maxInlineBytes) {
    const mb = (stat.size / (1024 * 1024)).toFixed(1);
    const cap = Math.round(maxInlineBytes / (1024 * 1024));
    throw new Error(
      `attachment ${basename(resolved)} is ${mb} MB. Inline attachments are capped at ${cap} MB. Use outlook_mail_create-mail-attachment-upload-session for larger files.`,
    );
  }

  const bytes = await fs.readFile(resolved);
  const { path: _path, filePath: _filePath, file_path: _filePath2, ...rest } = attachment;
  return {
    ...rest,
    "@odata.type":
      typeof attachment["@odata.type"] === "string"
        ? attachment["@odata.type"]
        : "#microsoft.graph.fileAttachment",
    name:
      typeof attachment.name === "string" && attachment.name ? attachment.name : basename(resolved),
    contentType:
      typeof attachment.contentType === "string" && attachment.contentType
        ? attachment.contentType
        : inferAttachmentContentType(resolved),
    contentBytes: bytes.toString("base64"),
  };
}

async function hydrateSendMail(
  args: Record<string, unknown>,
  workspaceDir: string | undefined,
  maxInlineBytes: number,
): Promise<boolean> {
  const body = record(args.body) ?? record(args.Body);
  if (!body) return false;
  const message = record(body.message) ?? record(body.Message) ?? body;
  const attachments = (message.attachments ?? message.Attachments) as unknown;
  if (!Array.isArray(attachments)) return false;

  let changed = false;
  for (let i = 0; i < attachments.length; i += 1) {
    const rec = record(attachments[i]);
    if (!rec) continue;
    const next = await hydrateAttachment(rec, workspaceDir, maxInlineBytes);
    if (next !== rec) {
      attachments[i] = next;
      changed = true;
    }
  }
  return changed;
}

async function hydrateAttachmentBody(
  args: Record<string, unknown>,
  workspaceDir: string | undefined,
  maxInlineBytes: number,
): Promise<boolean> {
  const key = args.body !== undefined ? "body" : args.Body !== undefined ? "Body" : undefined;
  if (!key) return false;
  const rec = record(args[key]);
  if (!rec) return false;
  const next = await hydrateAttachment(rec, workspaceDir, maxInlineBytes);
  if (next === rec) return false;
  args[key] = next;
  return true;
}

/** Replace any path-referenced attachments in `args` with inlined base64
 *  `contentBytes`, so the model can pass a file path instead of encoding bytes.
 *  Non-destructive: returns a fresh object only when something changed. */
export async function hydrateOutlookAttachments(
  toolName: string,
  args: Record<string, unknown>,
  opts: { workspaceDir?: string; maxInlineBytes?: number } = {},
): Promise<Record<string, unknown>> {
  if (!OUTLOOK_ATTACHMENT_TOOLS.has(toolName)) return args;
  const maxInlineBytes = opts.maxInlineBytes ?? MAX_INLINE_ATTACHMENT_BYTES;
  const clone = structuredClone(args) as Record<string, unknown>;
  const changed =
    toolName === "send-mail"
      ? await hydrateSendMail(clone, opts.workspaceDir, maxInlineBytes)
      : await hydrateAttachmentBody(clone, opts.workspaceDir, maxInlineBytes);
  return changed ? clone : args;
}
