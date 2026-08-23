/** Normalize image bytes so a vision API that validates the real bytes accepts them. */

import { MAX_IMAGE_BYTES, formatBytes } from "@reasonix/core-utils";
import { Jimp } from "jimp";

/** Actual raster format sniffed from magic bytes, or undefined if none match. */
export type SniffedImageFormat = "png" | "jpeg" | "gif" | "webp" | "bmp" | "tiff";

const MIME_BY_FORMAT: Record<SniffedImageFormat, string> = {
  png: "image/png",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  tiff: "image/tiff",
};

/** Detect the real raster format from magic bytes — the bytes, not the filename
 *  extension, are what the vision API validates against. */
export function sniffImageFormat(buf: Buffer): SniffedImageFormat | undefined {
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))) {
    return "png";
  }
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return "jpeg";
  }
  if (buf.length >= 6 && buf.subarray(0, 6).toString("ascii").startsWith("GIF8")) {
    return "gif";
  }
  if (
    buf.length >= 12 &&
    buf.subarray(0, 4).toString("ascii") === "RIFF" &&
    buf.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return "webp";
  }
  if (buf.length >= 2 && buf[0] === 0x42 && buf[1] === 0x4d) {
    return "bmp";
  }
  if (
    buf.length >= 4 &&
    ((buf[0] === 0x49 && buf[1] === 0x49 && buf[2] === 0x2a) ||
      (buf[0] === 0x4d && buf[1] === 0x4d && buf[3] === 0x2a))
  ) {
    return "tiff";
  }
  return undefined;
}

export interface NormalizeImageResult {
  ok: true;
  /** Guaranteed-acceptable data URL (data:image/webp|png|jpeg). */
  dataUrl: string;
  mime: string;
}

export interface NormalizeImageError {
  ok: false;
  message: string;
}

/** Normalize raw image bytes into a data URL the model's vision API accepts.
 *  Formats DeepSeek accepts pass through; non-raster/garbage is re-encoded to PNG. */
export async function normalizeImageToDataUrl(
  buf: Buffer,
  opts: { maxBytes?: number } = {},
): Promise<NormalizeImageResult | NormalizeImageError> {
  const max = opts.maxBytes ?? MAX_IMAGE_BYTES;
  if (buf.length === 0) return { ok: false, message: "image is empty" };
  if (buf.length > max) {
    return {
      ok: false,
      message: `image too large (${formatBytes(buf.length)} > ${formatBytes(max)})`,
    };
  }
  const format = sniffImageFormat(buf);
  // WebP can't be decoded by jimp's pure-JS decoders in Node (its wasm codec
  // fetches over HTTP), but the vision APIs accept webp as input, so pass the
  // original bytes through with the correct MIME.
  if (format === "webp") {
    return {
      ok: true,
      dataUrl: `data:image/webp;base64,${buf.toString("base64")}`,
      mime: MIME_BY_FORMAT.webp,
    };
  }
  if (format === "png" || format === "jpeg" || format === "gif") {
    // Already an accepted format — hand back the original bytes with the
    // sniffed MIME. No re-encode: lossless passthrough for png/gif, and jpeg
    // avoids a pointless generation loss.
    return {
      ok: true,
      dataUrl: `data:${MIME_BY_FORMAT[format]};base64,${buf.toString("base64")}`,
      mime: MIME_BY_FORMAT[format],
    };
  }
  // Non-accepted or unknown: decode + re-encode to a lossless PNG.
  try {
    const image = await Jimp.fromBuffer(buf);
    const png = await image.getBuffer("image/png");
    return {
      ok: true,
      dataUrl: `data:image/png;base64,${png.toString("base64")}`,
      mime: "image/png",
    };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { ok: false, message: `not a decodable image (${detail})` };
  }
}
