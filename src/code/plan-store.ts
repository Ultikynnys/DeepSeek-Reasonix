/** Persists structured plan state alongside the JSONL log; markdown body lives in the log (it was a tool result) and replays on resume. */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { readJsonFileSilently } from "../core/json-file.js";
import { fmtRelativeTime } from "../core/relative-time.js";
import { sanitizeName, sessionsDir } from "../memory/session.js";
import type { PlanStep, StepCompletion, StepEvidence } from "../tools/plan.js";

export interface PlanStateOnDisk {
  /** File format version — bump when shape changes. */
  version: 1 | 2;
  steps: PlanStep[];
  completedStepIds: string[];
  stepCompletions?: Record<string, StepCompletion>;
  /** ISO8601 timestamp of the last write. */
  updatedAt: string;
  body?: string;
  summary?: string;
}

export function planStatePath(sessionName: string): string {
  return join(sessionsDir(), `${sanitizeName(sessionName)}.plan.json`);
}

export function loadPlanState(sessionName: string): PlanStateOnDisk | null {
  const parsed = parsePlanFile(planStatePath(sessionName));
  if (!parsed) return null;
  if (!parsed.completedStepIds || typeof parsed.updatedAt !== "string") return null;
  const out: PlanStateOnDisk = {
    version: parsed.version,
    steps: parsed.steps,
    completedStepIds: parsed.completedStepIds,
    updatedAt: parsed.updatedAt,
  };
  if (parsed.stepCompletions) out.stepCompletions = parsed.stepCompletions;
  if (parsed.body) out.body = parsed.body;
  if (parsed.summary) out.summary = parsed.summary;
  return out;
}

/** Best-effort: write failure logs to stderr instead of crashing the TUI. */
export function savePlanState(
  sessionName: string,
  steps: PlanStep[],
  completedStepIds: Iterable<string>,
  extras?: {
    body?: string;
    summary?: string;
    stepCompletions?: ReadonlyMap<string, StepCompletion> | Record<string, StepCompletion>;
  },
): void {
  const path = planStatePath(sessionName);
  try {
    mkdirSync(dirname(path), { recursive: true });
    const state: PlanStateOnDisk = {
      version: 2,
      steps,
      completedStepIds: [...completedStepIds],
      updatedAt: new Date().toISOString(),
    };
    const stepCompletions = normalizeStepCompletionsForWrite(extras?.stepCompletions);
    if (stepCompletions) state.stepCompletions = stepCompletions;
    if (extras?.body) state.body = extras.body;
    if (extras?.summary) state.summary = extras.summary;
    writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  } catch (err) {
    process.stderr.write(
      `▸ plan-store: failed to save plan for "${sessionName}": ${(err as Error).message}\n`,
    );
  }
}

/** Remove the persisted plan, if any. Used on cancel / clean reset. */
export function clearPlanState(sessionName: string): void {
  const path = planStatePath(sessionName);
  try {
    if (existsSync(path)) unlinkSync(path);
  } catch {
    /* nothing to do — leftover file is harmless, will be overwritten next save */
  }
}

/** Random suffix avoids same-millisecond collision; `:`/`.` swapped for Windows-safe filenames. */
export function archivePlanState(sessionName: string): string | null {
  const active = planStatePath(sessionName);
  if (!existsSync(active)) return null;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const suffix = Math.random().toString(36).slice(2, 6);
  const archive = join(
    sessionsDir(),
    `${sanitizeName(sessionName)}.plan.${stamp}-${suffix}.done.json`,
  );
  try {
    renameSync(active, archive);
    return archive;
  } catch (err) {
    process.stderr.write(
      `▸ plan-store: failed to archive plan for "${sessionName}": ${(err as Error).message}\n`,
    );
    return null;
  }
}

export interface PlanArchiveSummary {
  path: string;
  completedAt: string;
  steps: PlanStep[];
  completedStepIds: string[];
  stepCompletions?: Record<string, StepCompletion>;
  /** Markdown body, when the archive carried it. */
  body?: string;
  /** One-line human-friendly title, when supplied. */
  summary?: string;
}

/** Parsed on-disk plan archive — reusable across listPlanArchives and listAllPlanArchives. */
interface ParsedPlanArchive {
  steps: PlanStep[];
  completedStepIds: string[];
  completedAt: string;
  stepCompletions?: Record<string, StepCompletion>;
  body?: string;
  summary?: string;
}

/** Raw JSON shape of a plan file before validation. */
interface RawPlanFile {
  version?: unknown;
  steps?: unknown;
  completedStepIds?: unknown;
  updatedAt?: unknown;
  stepCompletions?: unknown;
  body?: unknown;
  summary?: unknown;
}

/** Sanitized view shared by the live plan file and `.done.json` archives. */
interface PlanFileParsed {
  version: 1 | 2;
  steps: PlanStep[];
  /** Undefined when the file lacked a completedStepIds array — loadPlanState rejects that, archives default to []. */
  completedStepIds: string[] | undefined;
  /** Undefined when the file lacked updatedAt — loadPlanState rejects that, archives fall back to mtime. */
  updatedAt: string | undefined;
  stepCompletions?: Record<string, StepCompletion>;
  body?: string;
  summary?: string;
}

/** Read + validate + sanitize a plan file (live or archived). Null when missing, malformed, or yielding no usable steps. */
function parsePlanFile(path: string): PlanFileParsed | null {
  const raw = readJsonFileSilently(path, (v): v is RawPlanFile => !!v && typeof v === "object");
  if (!raw) return null;
  if (raw.version !== 1 && raw.version !== 2) return null;
  const steps = sanitizeSteps(raw.steps);
  if (steps.length === 0) return null;
  const completedStepIds = Array.isArray(raw.completedStepIds)
    ? raw.completedStepIds.filter((id): id is string => typeof id === "string" && id.length > 0)
    : undefined;
  const out: PlanFileParsed = {
    version: raw.version,
    steps,
    completedStepIds,
    updatedAt: undefined,
  };
  if (typeof raw.updatedAt === "string") out.updatedAt = raw.updatedAt;
  const stepCompletions = sanitizeStepCompletions(raw.stepCompletions);
  if (stepCompletions) out.stepCompletions = stepCompletions;
  if (typeof raw.body === "string" && raw.body) out.body = raw.body;
  if (typeof raw.summary === "string" && raw.summary) out.summary = raw.summary;
  return out;
}

function parsePlanArchiveFile(full: string): ParsedPlanArchive | null {
  const parsed = parsePlanFile(full);
  if (!parsed) return null;
  // Prefer the file's own updatedAt; fall back to mtime if missing
  // or unparseable so a hand-edited archive still sorts sensibly.
  let completedAt = parsed.updatedAt ?? "";
  if (!completedAt || Number.isNaN(Date.parse(completedAt))) {
    try {
      completedAt = statSync(full).mtime.toISOString();
    } catch {
      completedAt = new Date(0).toISOString();
    }
  }
  const result: ParsedPlanArchive = {
    steps: parsed.steps,
    completedStepIds: parsed.completedStepIds ?? [],
    completedAt,
  };
  if (parsed.stepCompletions) result.stepCompletions = parsed.stepCompletions;
  if (parsed.body) result.body = parsed.body;
  if (parsed.summary) result.summary = parsed.summary;
  return result;
}

/** Shared single-scan enumeration of archive files; `classify` returns the owning session name ("" when unused) or null to skip. */
function scanArchives(
  dir: string,
  classify: (name: string) => string | null,
): Array<{ sessionName: string; full: string }> {
  if (!existsSync(dir)) return [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const out: Array<{ sessionName: string; full: string }> = [];
  for (const name of entries) {
    const sessionName = classify(name);
    if (sessionName === null) continue;
    out.push({ sessionName, full: join(dir, name) });
  }
  return out;
}

function archiveSummaryFromParsed(parsed: ParsedPlanArchive, full: string): PlanArchiveSummary {
  const entry: PlanArchiveSummary = {
    path: full,
    completedAt: parsed.completedAt,
    steps: parsed.steps,
    completedStepIds: parsed.completedStepIds,
  };
  if (parsed.stepCompletions) entry.stepCompletions = parsed.stepCompletions;
  if (parsed.body) entry.body = parsed.body;
  if (parsed.summary) entry.summary = parsed.summary;
  return entry;
}

export function listPlanArchives(sessionName: string): PlanArchiveSummary[] {
  const prefix = `${sanitizeName(sessionName)}.plan.`;
  const suffix = ".done.json";
  const summaries: PlanArchiveSummary[] = [];
  for (const { full } of scanArchives(sessionsDir(), (name) =>
    name.startsWith(prefix) && name.endsWith(suffix) ? "" : null,
  )) {
    const parsed = parsePlanArchiveFile(full);
    if (parsed) summaries.push(archiveSummaryFromParsed(parsed, full));
  }
  summaries.sort((a, b) => b.completedAt.localeCompare(a.completedAt));
  return summaries;
}

export function isPlanComplete(state: PlanStateOnDisk): boolean {
  return state.completedStepIds.length >= state.steps.length;
}

/** Defensive: rebuild step entries, filtering malformed ones so a partially corrupted file still yields a usable subset. */
function sanitizeSteps(raw: unknown): PlanStep[] {
  if (!Array.isArray(raw)) return [];
  const steps: PlanStep[] = [];
  for (const s of raw) {
    if (!s || typeof s !== "object") continue;
    const e = s as unknown as Record<string, unknown>;
    if (typeof e.id !== "string" || !e.id) continue;
    if (typeof e.title !== "string" || !e.title) continue;
    if (typeof e.action !== "string" || !e.action) continue;
    const step: PlanStep = { id: e.id, title: e.title, action: e.action };
    if (e.risk === "low" || e.risk === "med" || e.risk === "high") step.risk = e.risk;
    const targets = stringList(e.targets);
    if (targets) step.targets = targets;
    if (typeof e.acceptance === "string" && e.acceptance.trim()) {
      step.acceptance = e.acceptance.trim();
    }
    const verification = stringList(e.verification);
    if (verification) step.verification = verification;
    steps.push(step);
  }
  return steps;
}

function stringList(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out = raw
    .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
    .filter((entry) => entry.length > 0);
  return out.length > 0 ? out : undefined;
}

function normalizeStepCompletionsForWrite(
  raw: ReadonlyMap<string, StepCompletion> | Record<string, StepCompletion> | undefined,
): Record<string, StepCompletion> | undefined {
  if (!raw) return undefined;
  const entries =
    raw instanceof Map
      ? [...raw.entries()]
      : (Object.entries(raw) as Array<[string, StepCompletion]>);
  const out: Record<string, StepCompletion> = {};
  for (const [key, value] of entries) {
    const completion = sanitizeStepCompletion(value, key);
    if (completion) out[completion.stepId] = completion;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function sanitizeStepCompletions(raw: unknown): Record<string, StepCompletion> | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const out: Record<string, StepCompletion> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const completion = sanitizeStepCompletion(value, key);
    if (completion) out[completion.stepId] = completion;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function sanitizeStepCompletion(raw: unknown, fallbackStepId?: string): StepCompletion | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const entry = raw as Record<string, unknown>;
  const stepId =
    typeof entry.stepId === "string" && entry.stepId.trim()
      ? entry.stepId.trim()
      : fallbackStepId?.trim();
  const result = typeof entry.result === "string" ? entry.result.trim() : "";
  if (!stepId || !result) return undefined;
  const completion: StepCompletion = { kind: "step_completed", stepId, result };
  if (typeof entry.title === "string" && entry.title.trim()) completion.title = entry.title.trim();
  if (typeof entry.notes === "string" && entry.notes.trim()) completion.notes = entry.notes.trim();
  const evidence = sanitizeEvidenceList(entry.evidence);
  if (evidence) completion.evidence = evidence;
  return completion;
}

function sanitizeEvidenceList(raw: unknown): StepEvidence[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: StepEvidence[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const entry = item as Record<string, unknown>;
    const kind = entry.kind;
    if (kind !== "verification" && kind !== "diff" && kind !== "checkpoint" && kind !== "manual") {
      continue;
    }
    const summary = typeof entry.summary === "string" ? entry.summary.trim() : "";
    if (!summary) continue;
    const evidence: StepEvidence = { kind, summary };
    if (typeof entry.command === "string" && entry.command.trim()) {
      evidence.command = entry.command.trim();
    }
    const paths = stringList(entry.paths);
    if (paths) evidence.paths = paths;
    out.push(evidence);
  }
  return out.length > 0 ? out : undefined;
}

/** Falls back to raw ISO string past a week — "47 days ago" misleads more than it helps. */
export function relativeTime(updatedAt: string, now: number = Date.now()): string {
  const t = Date.parse(updatedAt);
  if (Number.isNaN(t)) return updatedAt;
  const diffMs = Math.max(0, now - t);
  const day = Math.floor(diffMs / (1000 * 60 * 60 * 24));
  if (day >= 7) return updatedAt.slice(0, 10);
  return fmtRelativeTime(diffMs);
}
