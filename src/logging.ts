/** Leveled stderr logger gated by REASONIX_LOG_LEVEL. Default: info. */

export type LogLevel = "silent" | "error" | "warn" | "info" | "debug" | "verbose";

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  silent: 0,
  error: 1,
  warn: 2,
  info: 3,
  debug: 4,
  verbose: 5,
};

let globalLevel: LogLevel = resolveEnvLevel();

function resolveEnvLevel(): LogLevel {
  const raw = process.env.REASONIX_LOG_LEVEL?.trim().toLowerCase();
  if (raw === "verbose") return "verbose";
  if (raw === "debug") return "debug";
  if (raw === "info") return "info";
  if (raw === "warn") return "warn";
  if (raw === "error") return "error";
  if (raw === "silent" || raw === "off" || raw === "none") return "silent";
  return "info";
}

/** Override the global level at runtime (e.g. from a settings toggle). */
export function setLogLevel(level: LogLevel): void {
  globalLevel = level;
}

/** Current global level — callers can branch on this for expensive formatting. */
export function logLevel(): LogLevel {
  return globalLevel;
}

export interface Logger {
  error(msg: string): void;
  warn(msg: string): void;
  info(msg: string): void;
  debug(msg: string): void;
  verbose(msg: string): void;
}

class ConsoleLogger implements Logger {
  constructor(private readonly name: string) {}

  error(msg: string): void {
    this.emit("error", msg);
  }
  warn(msg: string): void {
    this.emit("warn", msg);
  }
  info(msg: string): void {
    this.emit("info", msg);
  }
  debug(msg: string): void {
    this.emit("debug", msg);
  }
  verbose(msg: string): void {
    this.emit("verbose", msg);
  }

  private emit(level: LogLevel, msg: string): void {
    if (LEVEL_PRIORITY[globalLevel] < LEVEL_PRIORITY[level]) return;
    // Timestamps are omitted — the desktop frontend already timestamps
    // each rpc:stderr line. Keep the format tight.
    process.stderr.write(`[${this.name}] ${msg}\n`);
  }
}

const cache = new Map<string, Logger>();

/** Named logger — reuse the same instance for a given name. */
export function createLogger(name: string): Logger {
  const existing = cache.get(name);
  if (existing) return existing;
  const logger = new ConsoleLogger(name);
  cache.set(name, logger);
  return logger;
}
