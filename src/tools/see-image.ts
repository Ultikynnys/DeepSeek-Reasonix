/** see_image: loads the image into the model's context (as image_url content
 *  parts) so a vision-capable model actually sees it, and confirms attachments. */

import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import {
  MAX_IMAGE_BYTES,
  formatBytes,
  imageMimeForExtension,
  isSupportedImagePath,
} from "@reasonix/core-utils";
import type { ToolCallContext, ToolRegistry } from "../tools.js";
import type { UserContentPart } from "../types.js";

export interface SeeImageToolOptions {
  /** Project root for resolving relative image paths. Defaults to ctx.rootDir. */
  rootDir?: string;
}

const DESCRIPTION =
  "Confirm and inspect images. You are vision-capable (multimodal): when the user attaches an image to their message, it is visible to you directly inside that user message; you can see and describe it without calling any tool. Call this tool when the user asks you to look at an image and you want to confirm the attachment, or pass `path` to load a specific local image file (PNG/JPEG/WebP) or data: URL into your context so you can see and describe it. Loading an image via `path` delivers its pixels to you as an image attachment. Never claim you cannot see an image you loaded or the user attached; if you are unsure whether an image is present, call this tool.";

/** Accept `data:image[...]` URLs and supported image file paths (absolute, or
 *  resolved against the tool root). Returns the resolved display form and, for
 *  a loadable image, a data URL carrying the pixels, or an error message. */
function resolveImageRef(
  raw: string,
  rootDir: string | undefined,
): { ok: true; label: string; bytes?: number; dataUrl?: string } | { ok: false; message: string } {
  const trimmed = raw.trim();
  if (trimmed.startsWith("data:image/")) {
    return { ok: true, label: "data URL", bytes: trimmed.length, dataUrl: trimmed };
  }
  if (!isSupportedImagePath(trimmed)) {
    return { ok: false, message: `unsupported image path "${raw}" — use PNG, JPEG or WebP` };
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
  const ext = abs.split(".").pop() ?? "";
  const mime = imageMimeForExtension(ext);
  const dataUrl = mime ? `data:${mime};base64,${readFileSync(abs).toString("base64")}` : undefined;
  return { ok: true, label: abs, bytes, dataUrl };
}

/** Build the tool result for a resolvable image: text confirmation + the
 *  image as an `image_url` content part so a vision model receives the pixels. */
function imageResultParts(
  label: string,
  bytes: number | undefined,
  dataUrl: string,
): UserContentPart[] {
  const size = bytes !== undefined ? ` (${formatBytes(bytes)})` : "";
  return [
    {
      type: "text",
      text: `Image loaded at ${label}${size}: pixels attached below. Describe what you observe.`,
    },
    { type: "image_url", image_url: { url: dataUrl, detail: "low" } },
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
            "Optional: a PNG/JPEG/WebP file path (absolute or workspace-relative) or a data:image/... URL. Omit to confirm the images attached to the current turn.",
        },
      },
    },
    fn: async (
      args: { path?: unknown },
      ctx?: ToolCallContext,
    ): Promise<string | UserContentPart[]> => {
      const raw = typeof args?.path === "string" ? args.path : "";
      if (raw) {
        const resolved = resolveImageRef(raw, ctx?.rootDir ?? opts.rootDir);
        if (!resolved.ok) return `see_image: ${resolved.message}`;
        if (resolved.dataUrl) {
          return imageResultParts(resolved.label, resolved.bytes, resolved.dataUrl);
        }
        const size = resolved.bytes ? ` (${formatBytes(resolved.bytes)})` : "";
        return `Image confirmed at ${resolved.label}${size}: it is visible to you; you are vision-capable and see it directly. Describe what you observe in your response.`;
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
