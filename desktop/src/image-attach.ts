/** Client-side image attachment helpers.
 *
 *  Paste gives a File in the webview (bytes available now); picked/dropped
 *  images give OS paths the daemon reads at send time (the webview has no fs
 *  access). Pasting downscales the bytes here so the session JSONL and the
 *  API request stay bounded. */

import { scanImageMentions, stripMentionTokens } from "@reasonix/core-utils";
import { convertFileSrc } from "@tauri-apps/api/core";

const MAX_EDGE = 2048;

/** True for raster formats the daemon's accept-list allows — re-exported from
 *  core-utils so the frontend filters can never drift from the daemon. */
export { isSupportedImagePath as isImagePath } from "@reasonix/core-utils";

/** Resolve a mention path (workspace-relative or absolute) to the absolute
 *  path the daemon's file-read accept-list expects. */
export function resolveImagePath(path: string, workspaceDir?: string): string {
  if (!workspaceDir || /^([a-zA-Z]:[\\/]|[/\\])/.test(path)) return path;
  return `${workspaceDir.replace(/[\\/]+$/, "")}/${path}`;
}

/** Optimistic echo for typed `@path` image mentions on ChatGPT models: strip
 *  the tokens from the displayed text and attach the real files via Tauri's
 *  asset protocol. Display-only — the daemon re-converts from the original
 *  text at send (existence-checked). `toSrc` is injectable for tests. */
export function typedMentionImages(
  text: string,
  workspaceDir?: string,
  toSrc: (path: string) => string = convertFileSrc,
): { text: string; images: string[] } {
  const mentions = scanImageMentions(text, (p) => resolveImagePath(p, workspaceDir));
  if (mentions.length === 0) return { text, images: [] };
  return {
    text: stripMentionTokens(text, mentions),
    images: mentions.map((m) => toSrc(m.path)),
  };
}

/** FileReader → data URL (original pixels). */
export function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error ?? new Error("FileReader failed"));
    reader.readAsDataURL(file);
  });
}

/** Downscale to ≤ maxEdge on the long edge via canvas, re-encoding as JPEG for
 *  photos and PNG for screenshots. Returns the original URL unchanged when the
 *  image is already small, the canvas is unavailable, or decoding fails. */
export async function downscaleImage(dataUrl: string, maxEdge = MAX_EDGE): Promise<string> {
  try {
    const img = await loadImage(dataUrl);
    const scale = Math.min(1, maxEdge / Math.max(img.naturalWidth, img.naturalHeight));
    if (scale >= 1) return dataUrl;
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
    const ctx = canvas.getContext("2d");
    if (!ctx) return dataUrl;
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    const mime = dataUrl.startsWith("data:image/jpeg") ? "image/jpeg" : "image/png";
    const out = canvas.toDataURL(mime, 0.9);
    return out.startsWith("data:image/") ? out : dataUrl;
  } catch {
    return dataUrl;
  }
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("image decode failed"));
    img.src = src;
  });
}
