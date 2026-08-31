import type { FileHandle } from "node:fs/promises";
import { createInterface } from "node:readline";
import type { Readable } from "node:stream";
import iconv from "iconv-lite";
import { type FileEncoding, decodeFileBuffer } from "../../code/file-encoding.js";
import { looksBinary } from "./binary.js";

const DETECT_SAMPLE_BYTES = 256 * 1024;

export interface TextFileInspection {
  encoding: FileEncoding;
  bomBytes: number;
  binary: boolean;
}

export async function inspectTextFile(
  fh: FileHandle,
  sizeBytes: number,
): Promise<TextFileInspection> {
  const sampleSize = Math.min(sizeBytes, DETECT_SAMPLE_BYTES);
  const sample = Buffer.allocUnsafe(sampleSize);
  const { bytesRead } = await fh.read(sample, 0, sampleSize, 0);
  const bytes = sample.subarray(0, bytesRead);
  if (looksBinary(bytes)) return { encoding: "utf8", bomBytes: 0, binary: true };

  const hasBom = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
  let detectionSample = bytes;
  if (bytesRead < sizeBytes) {
    const newline = bytes.lastIndexOf(0x0a);
    if (newline >= 0) detectionSample = bytes.subarray(0, newline + 1);
  }
  const { encoding } = decodeFileBuffer(detectionSample);
  return { encoding, bomBytes: hasBom ? 3 : 0, binary: false };
}

function decodedStream(
  fh: FileHandle,
  inspection: TextFileInspection,
): { source: Readable; decoded: Readable } {
  const source = fh.createReadStream({
    start: inspection.bomBytes,
    autoClose: false,
  });
  if (inspection.encoding === "gb18030") {
    return {
      source,
      decoded: source.pipe(iconv.decodeStream("gb18030")) as unknown as Readable,
    };
  }
  source.setEncoding("utf8");
  return { source, decoded: source };
}

export interface ReadLineWindow {
  lines: string[];
  hasMore: boolean;
  linesVisited: number;
}

/** Stream a 1-based line window, stopping one line after the requested end. */
export async function readLineWindow(
  fh: FileHandle,
  inspection: TextFileInspection,
  startLine: number,
  limit: number,
): Promise<ReadLineWindow> {
  const { source, decoded } = decodedStream(fh, inspection);
  const reader = createInterface({ input: decoded, crlfDelay: Number.POSITIVE_INFINITY });
  const lines: string[] = [];
  let lineNo = 0;
  let hasMore = false;
  try {
    for await (const line of reader) {
      lineNo++;
      if (lineNo < startLine) continue;
      if (lines.length < limit) {
        lines.push(line);
        continue;
      }
      hasMore = true;
      break;
    }
  } finally {
    reader.close();
    source.destroy();
    if (decoded !== source) decoded.destroy();
  }
  return { lines, hasMore, linesVisited: lineNo };
}

/** Stream every line while retaining only the final `limit` lines. */
export async function readLineTail(
  fh: FileHandle,
  inspection: TextFileInspection,
  limit: number,
): Promise<{ lines: string[]; totalLines: number }> {
  const { source, decoded } = decodedStream(fh, inspection);
  const reader = createInterface({ input: decoded, crlfDelay: Number.POSITIVE_INFINITY });
  const ring: string[] = [];
  let totalLines = 0;
  try {
    for await (const line of reader) {
      totalLines++;
      ring.push(line);
      if (ring.length > limit) ring.shift();
    }
  } finally {
    reader.close();
    source.destroy();
    if (decoded !== source) decoded.destroy();
  }
  return { lines: ring, totalLines };
}

/** Stream all lines to a callback without retaining the file body. */
export async function scanTextLines(
  fh: FileHandle,
  inspection: TextFileInspection,
  visit: (line: string, lineNo: number) => void,
): Promise<number> {
  const { source, decoded } = decodedStream(fh, inspection);
  const reader = createInterface({ input: decoded, crlfDelay: Number.POSITIVE_INFINITY });
  let totalLines = 0;
  try {
    for await (const line of reader) {
      totalLines++;
      visit(line, totalLines);
    }
  } finally {
    reader.close();
    source.destroy();
    if (decoded !== source) decoded.destroy();
  }
  return totalLines;
}
