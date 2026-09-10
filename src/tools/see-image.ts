/** see_image: loads the image into the model's context (as image_url content
 *  parts) so a vision-capable model actually sees it, and confirms attachments. */

import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { MAX_IMAGE_BYTES, formatBytes } from "@reasonix/core-utils";
import { normalizeImageToDataUrls } from "../image-format.js";
import type { ToolCallContext, ToolRegistry } from "../tools.js";
import type { UserContentPart } from "../types.js";

export interface SeeImageToolOptions {
  /** Project root for resolving relative image paths. Defaults to ctx.rootDir. */
  rootDir?: string;
}

const DESCRIPTION =
  "Confirm and inspect images. You are vision-capable (multimodal): when the user attaches an image to their message, it is visible to you directly inside that user message; you can see and describe it without calling any tool. Call this tool when the user asks you to look at an image and you want to confirm the attachment, or pass `path` to load a specific local image file (PNG/JPEG/WebP) or data: URL into your context so you can see and describe it. Loading an image via `path` delivers its pixels to you as an image attachment (a large image, such as a full-page screenshot, is split into tiles automatically so the whole image reaches you). Never claim you cannot see an image you loaded or the user attached; if you are unsure whether an image is present, call this tool.";

/** Resolve a data URL or image file path; bytes are sniffed (not extension-trusted). */
async function resolveImageRef(
  raw: string,
  rootDir: string | undefined,
): Promise<
  { ok: true; label: string; bytes?: number; dataUrls: string[] } | { ok: false; message: string }
> {
  const trimmed = raw.trim();
  if (trimmed.startsWith("data:image/")) {
    const comma = trimmed.indexOf(",");
    const b64 = comma >= 0 ? trimmed.slice(comma + 1) : "";
    let buf: Buffer;
    try {
      buf = Buffer.from(b64, "base64");
    } catch {
      return { ok: false, message: "invalid data:image URL — undecodable base64" };
    }
    const normalized = await normalizeImageToDataUrls(buf);
    if (!normalized.ok) return { ok: false, message: normalized.message };
    return { ok: true, label: "data URL", bytes: trimmed.length, dataUrls: normalized.dataUrls };
  }
  const abs = isAbsolute(trimmed) ? trimmed : rootDir ? join(rootDir, trimmed) : trimmed;
  if (!existsSync(abs) || !statSync(abs).isFile()) {
    return { ok: false, message: `no such image file: ${abs}` };
  }
  const bytes = statSync(abs).size;
  if (bytes > MAX_IMAGE_BYTES) {
    return {
      ok: false,
      message: `image too large (${formatBytes(bytes)} > ${formatBytes(MAX_IMAGE_BYTES)})`,
    };
  }
  const normalized = await normalizeImageToDataUrls(readFileSync(abs));
  if (!normalized.ok) return { ok: false, message: normalized.message };
  return { ok: true, label: abs, bytes, dataUrls: normalized.dataUrls };
}

/** Build the tool result for a resolvable image: text confirmation + one
 *  `image_url` part per tile so a vision model receives the pixels. An image
 *  over the vision cap is split into tiles upstream, so this may carry several. */
function imageResultParts(
  label: string,
  bytes: number | undefined,
  dataUrls: string[],
): UserContentPart[] {
  const size = bytes !== undefined ? ` (${formatBytes(bytes)})` : "";
  const tiles = dataUrls.length > 1 ? ` (split into ${dataUrls.length} tiles)` : "";
  return [
    {
      type: "text",
      text: `Image loaded at ${label}${size}${tiles}: pixels attached below. Describe what you observe.`,
    },
    ...dataUrls.map(
      (url): UserContentPart => ({ type: "image_url", image_url: { url, detail: "low" } }),
    ),
  ];
}

export function registerSeeImageTool(
  registry: ToolRegistry,
  opts: SeeImageToolOptions = {},
): ToolRegistry {
  registry.register({
    name: "see_image",
    description: DESCRIPTION,
    readOnly: true,
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description:
            "Optional: a local image file path (absolute or workspace-relative) or a data:image/... URL. The file's real format is detected from its bytes, not its extension.",
        },
      },
    },
    fn: async (
      args: { path?: unknown },
      ctx?: ToolCallContext,
    ): Promise<string | UserContentPart[]> => {
      const raw = typeof args?.path === "string" ? args.path : "";
      if (raw) {
        const resolved = await resolveImageRef(raw, ctx?.rootDir ?? opts.rootDir);
        if (!resolved.ok) return `see_image: ${resolved.message}`;
        return imageResultParts(resolved.label, resolved.bytes, resolved.dataUrls);
      }
      const attached = ctx?.images;
      if (attached && attached.length > 0) {
        return `Confirmed: ${attached.length} image(s) attached to the current turn: they are visible to you directly in the user message. Describe what you observe in your response.`;
      }
      return (
        "see_image: no image available — no image is attached to the current turn and no " +
        "`path` was given. Ask the user to attach an image, or pass an image file path."
      );
    },
  });
  return registry;
}
