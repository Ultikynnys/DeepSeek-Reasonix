/** Normalize image bytes so a vision API that validates the real bytes accepts them. */

import { MAX_IMAGE_BYTES, formatBytes, messageOf } from "@reasonix/core-utils";
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

/** True when a WebP's RIFF chunk list carries an ANIM / ANMF chunk (animated). */
export function isAnimatedWebp(buf: Buffer): boolean {
  if (buf.length < 12) return false;
  if (buf.subarray(0, 4).toString("ascii") !== "RIFF") return false;
  if (buf.subarray(8, 12).toString("ascii") !== "WEBP") return false;
  // Walk the RIFF chunk list: [fourCC(4)][size(4 LE)][payload][pad to even].
  let offset = 12;
  while (offset + 8 <= buf.length) {
    const fourCC = buf.subarray(offset, offset + 4).toString("ascii");
    const size = buf.readUInt32LE(offset + 4);
    if (fourCC === "ANIM" || fourCC === "ANMF") return true;
    // A lone lossy/lossless frame means a single static image, not animation.
    if (fourCC === "VP8 " || fourCC === "VP8L") return false;
    if (size === 0) break; // malformed guard — avoids an infinite loop
    offset += 8 + size + (size & 1);
  }
  return false;
}

export interface NormalizeImagesResult {
  ok: true;
  /** One or more guaranteed-acceptable data URLs (data:image/png|jpeg|gif; WebP
   *  is converted). An image whose longest side exceeds MAX_VISION_DIMENSION is
   *  sliced into tiles so each stays within the cap the vision APIs enforce. */
  dataUrls: string[];
  mime: string;
}

export interface NormalizeImagesError {
  ok: false;
  message: string;
}

/** DeepSeek's vision API rejects (400 "unsupported image") any image with a side
 *  above 8192 px; OpenAI/Gemini downsample large images anyway. An oversized
 *  image is therefore sliced into tiles no larger than this on their longest side. */
export const MAX_VISION_DIMENSION = 8192;

/** Raster dimensions read from the container header, without a full decode. */
function rasterDimensions(
  format: SniffedImageFormat,
  buf: Buffer,
): { width: number; height: number } | undefined {
  if (format === "png") {
    // IHDR: width and height are big-endian uint32 at offsets 16 and 20.
    if (buf.length < 24) return undefined;
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  if (format === "gif") {
    if (buf.length < 10) return undefined;
    return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
  }
  if (format === "jpeg") {
    // Walk the segment markers for a SOFn frame header (skip DHT/JPG/DAC).
    let i = 2;
    while (i + 9 <= buf.length) {
      if (buf[i] !== 0xff) {
        i++;
        continue;
      }
      const marker = buf[i + 1]!;
      if (
        marker >= 0xc0 &&
        marker <= 0xcf &&
        marker !== 0xc4 &&
        marker !== 0xc8 &&
        marker !== 0xcc
      ) {
        return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
      }
      const len = buf.readUInt16BE(i + 2);
      if (len < 2) return undefined;
      i += 2 + len;
    }
    return undefined;
  }
  return undefined;
}

/** Decode a WebP's first frame to PNG pixels via sharp (lazy-imported to keep
 *  startup light — sharp is a native addon only needed on the WebP path). */
async function decodeWebpFirstFrameToPng(buf: Buffer): Promise<Buffer | null> {
  try {
    const { default: sharp } = await import("sharp");
    return await sharp(buf, { page: 0, pages: 1 }).png().toBuffer();
  } catch {
    return null;
  }
}

/** Normalize raw bytes into one or more vision-acceptable data URLs: accepted
 *  formats within the cap pass through, WebP is converted, garbage is re-encoded
 *  to PNG, and an overweight image is sliced into a grid of capped tiles. */
export async function normalizeImageToDataUrls(
  buf: Buffer,
  opts: { maxBytes?: number } = {},
): Promise<NormalizeImagesResult | NormalizeImagesError> {
  const max = opts.maxBytes ?? MAX_IMAGE_BYTES;
  if (buf.length === 0) return { ok: false, message: "image is empty" };
  if (buf.length > max) {
    return {
      ok: false,
      message: `image too large (${formatBytes(buf.length)} > ${formatBytes(max)})`,
    };
  }
  const format = sniffImageFormat(buf);
  // jimp can't decode WebP, and the vision APIs reject it (animated and often
  // static alike) despite the error text listing it, so ALWAYS convert WebP to
  // PNG via sharp. An animated WebP yields its first frame; a static one its
  // single frame. Removes any dependence on format-acceptance quirks.
  let source = buf;
  let sourceFormat: SniffedImageFormat | undefined = format;
  if (format === "webp") {
    const png = await decodeWebpFirstFrameToPng(buf);
    if (!png) {
      return {
        ok: false,
        message:
          "WebP could not be decoded; save or export the image as a static PNG, JPEG, or GIF.",
      };
    }
    source = png;
    sourceFormat = "png";
  }
  // Fast path: an accepted format already inside the dimension cap, handed back
  // unchanged (lossless for png/gif; jpeg avoids a pointless generation loss).
  if (sourceFormat === "png" || sourceFormat === "jpeg" || sourceFormat === "gif") {
    const dims = rasterDimensions(sourceFormat, source);
    if (dims && dims.width <= MAX_VISION_DIMENSION && dims.height <= MAX_VISION_DIMENSION) {
      return {
        ok: true,
        dataUrls: [`data:${MIME_BY_FORMAT[sourceFormat]};base64,${source.toString("base64")}`],
        mime: MIME_BY_FORMAT[sourceFormat],
      };
    }
  }
  // Decode, then emit either one PNG or a grid of capped tiles.
  try {
    const image = await Jimp.fromBuffer(source);
    const { width, height } = image;
    if (width <= MAX_VISION_DIMENSION && height <= MAX_VISION_DIMENSION) {
      const png = await image.getBuffer("image/png");
      return {
        ok: true,
        dataUrls: [`data:image/png;base64,${png.toString("base64")}`],
        mime: "image/png",
      };
    }
    const cols = Math.ceil(width / MAX_VISION_DIMENSION);
    const rows = Math.ceil(height / MAX_VISION_DIMENSION);
    const tileW = Math.ceil(width / cols);
    const tileH = Math.ceil(height / rows);
    const dataUrls: string[] = [];
    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        const x = col * tileW;
        const y = row * tileH;
        const tile = image.clone().crop({
          x,
          y,
          w: Math.min(tileW, width - x),
          h: Math.min(tileH, height - y),
        });
        const png = await tile.getBuffer("image/png");
        dataUrls.push(`data:image/png;base64,${png.toString("base64")}`);
      }
    }
    return { ok: true, dataUrls, mime: "image/png" };
  } catch (err) {
    const detail = messageOf(err);
    return { ok: false, message: `not a decodable image (${detail})` };
  }
}
