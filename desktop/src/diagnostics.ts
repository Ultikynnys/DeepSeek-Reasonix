import { redactDiagnosticValue } from "@reasonix/core-utils";
import { invoke } from "@tauri-apps/api/core";

export type FrontendDiagnosticLevel = "error" | "warn" | "info" | "debug" | "verbose";

const bootStartedAt = performance.now();
let installed = false;
let queue = Promise.resolve();
const MAX_DEPTH = 3;
const PERFORMANCE_BATCH_DELAY_MS = 100;
const DIAGNOSTIC_COMMAND = "record_frontend_diagnostic";
const performanceEntries: Record<string, unknown>[] = [];
let performanceFlushTimer: ReturnType<typeof setTimeout> | undefined;
let performanceCallbackActive = false;

export function isFrontendDiagnosticResource(name: string): boolean {
  try {
    const url = new URL(name, window.location.href);
    return (
      url.hostname === "ipc.localhost" &&
      (url.pathname.includes(DIAGNOSTIC_COMMAND) || url.href.includes(DIAGNOSTIC_COMMAND))
    );
  } catch {
    return name.includes(DIAGNOSTIC_COMMAND);
  }
}

function safeValue(value: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) return "[max-depth]";
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message.slice(0, 2000),
      stack: value.stack?.slice(0, 8000),
    };
  }
  if (typeof value === "string") return value.slice(0, 2000);
  if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => safeValue(item, depth + 1));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .slice(0, 40)
        .map(([key, child]) => [key, safeValue(child, depth + 1)]),
    );
  }
  return String(value).slice(0, 2000);
}

export function recordFrontendDiagnostic(
  event: string,
  details: Record<string, unknown> = {},
  level: FrontendDiagnosticLevel = "debug",
): void {
  queue = queue.then(async () => {
    try {
      await invoke(DIAGNOSTIC_COMMAND, {
        level,
        event,
        details: redactDiagnosticValue(safeValue(details)),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      window.console.error(`[diagnostics] frontend write failed: ${message}`);
    }
  });
}

function flushPerformanceEntries(): void {
  performanceFlushTimer = undefined;
  if (performanceEntries.length === 0) return;
  const entries = performanceEntries.splice(0, performanceEntries.length);
  recordFrontendDiagnostic(
    "frontend.performance.batch",
    { count: entries.length, entries },
    "verbose",
  );
}

function queuePerformanceEntry(details: Record<string, unknown>): void {
  performanceEntries.push(details);
  if (performanceFlushTimer) return;
  performanceFlushTimer = setTimeout(flushPerformanceEntries, PERFORMANCE_BATCH_DELAY_MS);
}

function observePerformance(): void {
  const supported = PerformanceObserver.supportedEntryTypes;
  const requested = ["navigation", "paint", "resource", "longtask", "measure", "mark"];
  for (const type of requested) {
    if (!supported.includes(type)) {
      recordFrontendDiagnostic("frontend.performance.unsupported", { entryType: type }, "info");
      continue;
    }
    const observer = new PerformanceObserver((list) => {
      if (performanceCallbackActive) return;
      performanceCallbackActive = true;
      try {
        for (const entry of list.getEntries()) {
          if (entry.entryType === "resource" && isFrontendDiagnosticResource(entry.name)) continue;
          const details: Record<string, unknown> = {
            entryType: entry.entryType,
            name: entry.name,
            startTimeMs: Number(entry.startTime.toFixed(3)),
            durationMs: Number(entry.duration.toFixed(3)),
          };
          if (entry instanceof PerformanceResourceTiming) {
            details.initiatorType = entry.initiatorType;
            details.transferSize = entry.transferSize;
            details.encodedBodySize = entry.encodedBodySize;
            details.decodedBodySize = entry.decodedBodySize;
          }
          queuePerformanceEntry(details);
        }
      } finally {
        performanceCallbackActive = false;
      }
    });
    observer.observe({ type, buffered: true });
  }
}

export function installFrontendDiagnostics(): void {
  if (installed) return;
  installed = true;
  recordFrontendDiagnostic(
    "frontend.boot_started",
    {
      bootStartedAtMs: Number(bootStartedAt.toFixed(3)),
      userAgent: navigator.userAgent,
      language: navigator.language,
      hardwareConcurrency: navigator.hardwareConcurrency,
      deviceMemoryGb: (navigator as Navigator & { deviceMemory?: number }).deviceMemory,
    },
    "info",
  );
  window.addEventListener("error", (event) => {
    recordFrontendDiagnostic(
      "frontend.window_error",
      {
        message: event.message,
        filename: event.filename,
        line: event.lineno,
        column: event.colno,
        error: event.error,
      },
      "error",
    );
  });
  window.addEventListener("unhandledrejection", (event) => {
    recordFrontendDiagnostic("frontend.unhandled_rejection", { reason: event.reason }, "error");
  });
  document.addEventListener("visibilitychange", () => {
    recordFrontendDiagnostic("frontend.visibility_changed", { state: document.visibilityState });
  });
  observePerformance();
}

export function markFrontendReady(): void {
  const durationMs = performance.now() - bootStartedAt;
  performance.mark("reasonix.frontend.ready");
  recordFrontendDiagnostic("frontend.ready", { durationMs: Number(durationMs.toFixed(3)) }, "info");
}
