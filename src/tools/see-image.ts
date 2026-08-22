/** see_image: confirms attached images for vision-capable models and verifies image file paths. */

import { existsSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { MAX_IMAGE_BYTES, formatBytes, isSupportedImagePath } from "@reasonix/core-utils";
import type { ToolCallContext, ToolRegistry } from "../tools.js";

export interface SeeImageToolOptions {
  /** Project root for resolving relative image paths. Defaults to ctx.rootDir. */
  rootDir?: string;
}

const DESCRIPTION =
  "Confirm and inspect images. You are vision-capable (multimodal): when the user attaches an image to their message, it is visible to you directly inside that user message; you can see and describe it without calling any tool. Call this tool when the user asks you to look at an image and you want to confirm the attachment, or pass `path` to verify a specific local image file (PNG/JPEG/WebP) or data: URL. Never claim you cannot see an image the user attached; if you are unsure whether an image is present, call this tool.";

/** Accept `data:image/...` URLs and supported image file paths (absolute, or
 *  resolved against the tool root). Returns the resolved display form, or an
 *  error message describing the failure. */
function resolveImageRef(
  raw: string,
  rootDir: string | undefined,
): { ok: true; label: string; bytes?: number } | { ok: false; message: string } {
  const trimmed = raw.trim();
  if (trimmed.startsWith("data:image/")) {
    return { ok: true, label: "data URL", bytes: trimmed.length };
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
  return { ok: true, label: abs, bytes };
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
    fn: async (args: { path?: unknown }, ctx?: ToolCallContext): Promise<string> => {
      const raw = typeof args?.path === "string" ? args.path : "";
      if (raw) {
        const resolved = resolveImageRef(raw, ctx?.rootDir ?? opts.rootDir);
        if (!resolved.ok) return `see_image: ${resolved.message}`;
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
