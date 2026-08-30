/** Durable, content-safe diagnostics shared by CLI and desktop backend code. */

import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { redactDiagnosticText, redactDiagnosticValue } from "@reasonix/core-utils";
import { reasonixHome } from "./reasonix-home.js";

export type DiagnosticLevel = "error" | "warn" | "info" | "debug" | "verbose";

export interface DiagnosticRecord {
  ts: string;
  monotonicMs: number;
  launchId: string;
  sequence: number;
  pid: number;
  source: string;
  level: DiagnosticLevel;
  event: string;
  message?: string;
  durationMs?: number;
  details?: Record<string, unknown>;
}

interface DiagnosticsOptions {
  directory?: string;
  source?: string;
  maxFileBytes?: number;
  retainedFiles?: number;
}

const DEFAULT_MAX_FILE_BYTES = 10 * 1024 * 1024;
const DEFAULT_RETAINED_FILES = 10;
const FILE_PREFIX = "reasonix-diagnostics-";

let directory = join(reasonixHome(), "diagnostics");
let source = "backend";
let maxFileBytes = DEFAULT_MAX_FILE_BYTES;
let retainedFiles = DEFAULT_RETAINED_FILES;
let launchId = process.env.REASONIX_LAUNCH_ID || randomUUID();
let sequence = 0;
let segment = 0;
let fd: number | null = null;
let filePath: string | null = null;
let fileBytes = 0;
let recordingFailure = false;

function diagnosticFileName(): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const suffix = segment === 0 ? "" : `-${segment}`;
  return `${FILE_PREFIX}${stamp}-${process.pid}-${launchId}${suffix}.jsonl`;
}

function pruneOldFiles(): void {
  const files = readdirSync(directory)
    .filter((name) => name.startsWith(FILE_PREFIX) && name.endsWith(".jsonl"))
    .map((name) => ({ name, mtimeMs: statSync(join(directory, name)).mtimeMs }))
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  for (const stale of files.slice(Math.max(0, retainedFiles - 1))) {
    unlinkSync(join(directory, stale.name));
  }
}

function openSink(): void {
  if (fd !== null) return;
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  pruneOldFiles();
  filePath = join(directory, diagnosticFileName());
  fd = openSync(filePath, "a", 0o600);
  fileBytes = existsSync(filePath) ? statSync(filePath).size : 0;
}

function rotateIfNeeded(nextBytes: number): void {
  if (fd === null || filePath === null || fileBytes + nextBytes <= maxFileBytes) return;
  closeSync(fd);
  fd = null;
  segment += 1;
  filePath = null;
  openSink();
}

function safeEventName(event: string): string {
  const cleaned = event.replace(/[^a-zA-Z0-9_.:-]/g, "_").slice(0, 160);
  return cleaned || "diagnostic.unnamed";
}

export function configureDiagnostics(options: DiagnosticsOptions = {}): void {
  if (fd !== null) closeDiagnostics();
  directory = options.directory ?? join(reasonixHome(), "diagnostics");
  source = options.source ?? "backend";
  maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  retainedFiles = options.retainedFiles ?? DEFAULT_RETAINED_FILES;
  launchId = randomUUID();
  sequence = 0;
  segment = 0;
  filePath = null;
  fileBytes = 0;
  openSink();
  recordDiagnostic("diagnostics.started", {
    details: {
      file: filePath,
      hostname: hostname(),
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      maxFileBytes,
      retainedFiles,
    },
  });
}

export function recordDiagnostic(
  event: string,
  input: {
    level?: DiagnosticLevel;
    message?: string;
    durationMs?: number;
    details?: Record<string, unknown>;
    source?: string;
  } = {},
): void {
  try {
    openSink();
    const record: DiagnosticRecord = {
      ts: new Date().toISOString(),
      monotonicMs: Number(performance.now().toFixed(3)),
      launchId,
      sequence: ++sequence,
      pid: process.pid,
      source: input.source ?? source,
      level: input.level ?? "debug",
      event: safeEventName(event),
      ...(input.message ? { message: redactDiagnosticText(input.message) } : {}),
      ...(input.durationMs !== undefined
        ? { durationMs: Number(Math.max(0, input.durationMs).toFixed(3)) }
        : {}),
      ...(input.details
        ? { details: redactDiagnosticValue(input.details) as Record<string, unknown> }
        : {}),
    };
    const line = `${JSON.stringify(record)}\n`;
    const bytes = Buffer.byteLength(line);
    rotateIfNeeded(bytes);
    if (fd === null) throw new Error("diagnostics sink is not open");
    writeSync(fd, line, undefined, "utf8");
    fileBytes += bytes;
  } catch (error) {
    if (!recordingFailure) {
      recordingFailure = true;
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`[diagnostics] durable write failed: ${message}\n`);
      recordingFailure = false;
    }
    throw error;
  }
}

export function diagnosticsFilePath(): string {
  openSink();
  if (!filePath) throw new Error("diagnostics file path unavailable");
  return filePath;
}

export function diagnosticsLaunchId(): string {
  return launchId;
}

export function closeDiagnostics(): void {
  if (fd === null) return;
  recordDiagnostic("diagnostics.stopping", { level: "info" });
  closeSync(fd);
  fd = null;
}

export function _resetDiagnosticsForTests(): void {
  if (fd !== null) closeSync(fd);
  fd = null;
  filePath = null;
  fileBytes = 0;
  sequence = 0;
  segment = 0;
  launchId = randomUUID();
  directory = join(reasonixHome(), "diagnostics");
  source = "backend";
  maxFileBytes = DEFAULT_MAX_FILE_BYTES;
  retainedFiles = DEFAULT_RETAINED_FILES;
}
