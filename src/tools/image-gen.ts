/** generate_image: text-to-image via the user's signed-in ChatGPT/OpenAI plan
 *  (no API key); registered only when an OpenAI OAuth session exists. */

import { mkdirSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { formatBytes } from "@reasonix/core-utils";
import { type GenerateImageOptions, generateImageViaCodex } from "../codex-backend.js";
import { atomicReplaceFileSync } from "../core/atomic-write.js";
import { reasonixHome } from "../reasonix-home.js";
import type { ToolCallContext, ToolRegistry } from "../tools.js";
import type { UserContentPart } from "../types.js";

export interface ImageGenToolOptions {
  /** Project root for resolving `out_path` and the default output dir. */
  rootDir?: string;
  /** Override the `~/.reasonix/config.json` lookup — primarily for tests. */
  configPath?: string;
  /** Override the generation timeout (ms). */
  timeoutMs?: number;
  /** Test seam — defaults to the real Codex backend call. */
  generate?: (opts: GenerateImageOptions) => ReturnType<typeof generateImageViaCodex>;
}

/** Output directory under the workspace: `<root>/.reasonix/generated-images`. */
const GENERATED_DIR = "generated-images";

const SIZES = ["auto", "1024x1024", "1536x1024", "1024x1536"] as const;
const QUALITIES = ["auto", "low", "medium", "high"] as const;
const BACKGROUNDS = ["auto", "transparent", "opaque"] as const;

export type ImageSize = (typeof SIZES)[number];
export type ImageQuality = (typeof QUALITIES)[number];
export type ImageBackground = (typeof BACKGROUNDS)[number];

const DESCRIPTION =
  "Generate an image from a text prompt and save it as a PNG in the workspace. Runs on the user's signed-in OpenAI/ChatGPT account (draws on plan quota — not billed against an OpenAI API key), so it is available only when an OpenAI OAuth session is configured. Returns the saved path plus the pixels so you can see the result. Use it for icons, illustrations, textures, banners, or any visual asset the task needs.";

function oneOf<T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
  return typeof value === "string" && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : undefined;
}

/** PNG signature check — never trust the extension or the backend blindly. */
function isPng(bytes: Buffer): boolean {
  return (
    bytes.length > 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  );
}

function slugify(prompt: string): string {
  const slug = prompt
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48);
  return slug || "image";
}

/** Resolve the storage directory: workspace `.reasonix` when rooted, else `~/.reasonix`. */
function generatedDir(rootDir: string | undefined): string {
  const base = rootDir ? join(resolve(rootDir), ".reasonix") : reasonixHome();
  return join(base, GENERATED_DIR);
}

/** Absolute output path — explicit `out_path` (root-relative) or a default name. */
function resolveOutPath(rawOut: unknown, rootDir: string | undefined, prompt: string): string {
  if (typeof rawOut === "string" && rawOut.trim()) {
    const trimmed = rawOut.trim();
    const abs = isAbsolute(trimmed)
      ? trimmed
      : rootDir
        ? join(resolve(rootDir), trimmed)
        : resolve(trimmed);
    return abs.endsWith(".png") ? abs : `${abs}.png`;
  }
  const name = `${slugify(prompt)}-${Date.now()}.png`;
  return join(generatedDir(rootDir), name);
}

/** Text confirmation + an `image_url` part so a vision model receives the pixels. */
function imageResultParts(
  path: string,
  bytes: number,
  pngBase64: string,
  model: string,
): UserContentPart[] {
  return [
    {
      type: "text",
      text: `Generated image saved at ${path} (${formatBytes(bytes)}, model ${model}). Pixels attached below — describe or use them.`,
    },
    { type: "image_url", image_url: { url: `data:image/png;base64,${pngBase64}`, detail: "low" } },
  ];
}

export function registerImageGenTool(
  registry: ToolRegistry,
  opts: ImageGenToolOptions = {},
): ToolRegistry {
  registry.register({
    name: "generate_image",
    description: DESCRIPTION,
    readOnly: false,
    parameters: {
      type: "object",
      properties: {
        prompt: {
          type: "string",
          description:
            "Text description of the image to generate. Describe the subject, style, palette, and composition; say 'no text' when you don't want lettering.",
        },
        size: {
          type: "string",
          enum: [...SIZES],
          description: "Output dimensions — auto (default), square, landscape, or portrait.",
        },
        quality: {
          type: "string",
          enum: [...QUALITIES],
          description: "Render quality — auto (default), low, medium, or high.",
        },
        background: {
          type: "string",
          enum: [...BACKGROUNDS],
          description: "Background treatment — auto (default), transparent, or opaque.",
        },
        out_path: {
          type: "string",
          description:
            "Optional output PNG path (workspace-relative or absolute). Defaults to .reasonix/generated-images/<slug>-<timestamp>.png.",
        },
      },
      required: ["prompt"],
    },
    fn: async (
      args: {
        prompt?: unknown;
        size?: unknown;
        quality?: unknown;
        background?: unknown;
        out_path?: unknown;
      },
      ctx?: ToolCallContext,
    ): Promise<string | UserContentPart[]> => {
      const prompt = typeof args?.prompt === "string" ? args.prompt.trim() : "";
      if (!prompt) return "generate_image: `prompt` is required and must be non-empty.";

      const generate = opts.generate ?? generateImageViaCodex;
      const result = await generate({
        prompt,
        size: oneOf<ImageSize>(args?.size, SIZES),
        quality: oneOf<ImageQuality>(args?.quality, QUALITIES),
        background: oneOf<ImageBackground>(args?.background, BACKGROUNDS),
        timeoutMs: opts.timeoutMs,
        signal: ctx?.signal,
        configPath: opts.configPath,
      });
      if (!result.ok) return `generate_image: ${result.reason}`;

      const buffer = Buffer.from(result.pngBase64, "base64");
      if (!isPng(buffer)) return "generate_image: the backend returned non-PNG bytes.";

      const rootDir = ctx?.rootDir ?? opts.rootDir;
      const path = resolveOutPath(args?.out_path, rootDir, prompt);
      try {
        mkdirSync(dirname(path), { recursive: true });
        atomicReplaceFileSync(path, buffer, 0o600);
      } catch (err) {
        return `generate_image: could not save image — ${(err as Error).message}`;
      }
      return imageResultParts(path, buffer.length, result.pngBase64, result.model);
    },
  });
  return registry;
}
