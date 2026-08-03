import { resolve as resolvePath } from "node:path";
import { Box, type Color, Link, Text, useStdout } from "ink";
import React from "react";
import { t } from "../../../i18n/index.js";
import { Markdown } from "../markdown.js";
import { Card } from "../primitives/Card.js";
import { CardHeader, type MetaItem } from "../primitives/CardHeader.js";
import { PULSE_SQUARE, Pulse } from "../primitives/Pulse.js";
import type { ToolCard as ToolCardData } from "../state/cards.js";
import { useIsInflight } from "../state/inflight-context.js";
import { VerboseContext } from "../state/verbose-context.js";
import { WorkspaceRootContext } from "../state/workspace-root-context.js";
import { clipToCells } from "../text-width.js";
import { FG, TONE, TONE_ACTIVE } from "../theme/tokens.js";
import { selectToolPreviewLines } from "../tool-summary.js";

const READ_TAIL = 2;
const OTHER_TAIL = 5;

/** Read-style tools dump file/list bodies — short tail is enough; the model already has the full text in context. */
function tailLinesFor(name: string): number {
  const lower = name.toLowerCase();
  return /(?:^|_)(read|search|list|tree|get|status|diff|fetch|grep)(_|$)/.test(lower) ||
    lower === "job_output"
    ? READ_TAIL
    : OTHER_TAIL;
}

export function ToolCard({ card }: { card: ToolCardData }): React.ReactElement {
  const { stdout } = useStdout();
  const cols = stdout?.columns ?? 80;
  const lineCells = Math.max(20, cols - 4);
  const argsLabel = formatArgsSummary(card.args);

  const subagentMarkdown = React.useMemo(
    () => unwrapSubagentMarkdown(card.name, card.output),
    [card.name, card.output],
  );

  const rootDir = React.useContext(WorkspaceRootContext);
  const verbose = React.useContext(VerboseContext);
  const fileRef = React.useMemo(
    () => (rootDir ? extractFileRef(card.name, card.args) : null),
    [rootDir, card.name, card.args],
  );
  const tail = tailLinesFor(card.name);
  const preview = selectToolPreviewLines({
    toolName: card.name,
    output: card.output,
    exitCode: card.exitCode,
    tailLines: tail,
    verbose,
  });
  const firstHiddenRow = preview.rows.findIndex((row) => row.kind === "hidden");
  const isInflight = useIsInflight(card.id);
  const status = toolStatus(card, isInflight);
  const headColor = headerColorFor(status);
  const errColor = card.exitCode && card.exitCode !== 0 ? TONE.err : FG.sub;
  // Rejected calls show a single trailing badge — the verbose JSON error body
  // is already conveyed by the badge, so dropping the body keeps the card tight.
  const showBody = !card.rejected && (subagentMarkdown !== null || preview.rows.length > 0);

  const meta: MetaItem[] = [];
  if (card.retry) {
    meta.push({ text: `↻ ${card.retry.attempt}/${card.retry.max}`, color: TONE.warn });
  }
  if (card.rejected) {
    meta.push({ text: t("cardLabels.rejected"), color: TONE.err });
  }
  for (const part of metaTrail(card)) meta.push(part);

  const headerGlyph =
    status === "running" ? (
      <Pulse active frames={PULSE_SQUARE} settled="▣" color={headColor} />
    ) : (
      statusGlyph(status)
    );
  return (
    <Card tone={headColor}>
      <CardHeader
        glyph={headerGlyph}
        tone={headColor}
        title={card.name}
        subtitle={argsLabel || undefined}
        meta={meta.length > 0 ? meta : undefined}
      />
      {fileRef && (
        <Box flexDirection="row">
          <Text color={FG.faint}> ↗ </Text>
          <Link url={fileUrl(fileRef, rootDir!)}>
            <Text color={TONE.brand} underline>
              {fileRef.path}
              {fileRef.line ? `:${fileRef.line}` : ""}
            </Text>
          </Link>
        </Box>
      )}
      {showBody &&
        (subagentMarkdown !== null ? (
          <Markdown text={subagentMarkdown} width={lineCells} />
        ) : (
          <>
            {preview.rows.map((row, i) =>
              row.kind === "hidden" ? (
                <Text key={`${card.id}:hidden:${i}`} color={FG.faint}>
                  {t(
                    hiddenRowLabelKey({
                      count: row.count,
                      includeShortcut: i === firstHiddenRow,
                    }),
                    { count: row.count },
                  )}
                </Text>
              ) : (
                <Text
                  key={`${card.id}:line:${row.index}`}
                  color={errColor}
                  dim={!card.exitCode || card.exitCode === 0}
                >
                  {clipToCells(row.text, lineCells) || " "}
                </Text>
              ),
            )}
          </>
        ))}
    </Card>
  );
}

function hiddenRowLabelKey({
  count,
  includeShortcut,
}: {
  count: number;
  includeShortcut: boolean;
}):
  | "cardLabels.earlierLine"
  | "cardLabels.earlierLines"
  | "cardLabels.hiddenLine"
  | "cardLabels.hiddenLines" {
  if (includeShortcut) return count === 1 ? "cardLabels.earlierLine" : "cardLabels.earlierLines";
  return count === 1 ? "cardLabels.hiddenLine" : "cardLabels.hiddenLines";
}

function unwrapSubagentMarkdown(name: string, output: string): string | null {
  if (name !== "spawn_subagent") return null;
  if (output.length === 0) return null;
  try {
    const parsed = JSON.parse(output) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    const obj = parsed as Record<string, unknown>;
    if (obj.success !== true) return null;
    if (typeof obj.output !== "string") return null;
    return obj.output;
  } catch {
    return null;
  }
}

type ToolStatus = "running" | "ok" | "rejected" | "error" | "aborted";

function toolStatus(card: ToolCardData, isInflight: boolean): ToolStatus {
  // Running is derived from the loop's inflight set so a missed `tool` event
  // can't strand the spinner forever — finally in runOneToolCall guarantees
  // the id leaves the set on every exit path.
  if (isInflight) return "running";
  if (card.rejected) return "rejected";
  if (card.aborted) return "aborted";
  if (card.exitCode !== undefined && card.exitCode !== 0) return "error";
  return "ok";
}

function statusGlyph(s: ToolStatus): string {
  switch (s) {
    case "running":
      return "●";
    case "ok":
      return "✓";
    case "rejected":
      return "✗";
    case "error":
      return "✗";
    case "aborted":
      return "⊘";
  }
}

function headerColorFor(s: ToolStatus): Color {
  switch (s) {
    case "ok":
      return TONE.ok;
    case "rejected":
    case "error":
    case "aborted":
      return TONE.err;
    case "running":
      return TONE_ACTIVE.brand;
  }
}

function metaTrail(card: ToolCardData): string[] {
  const parts: string[] = [];
  const inputBytes = largestStringInputBytes(card.args);
  if (inputBytes !== null) parts.push(t("cardLabels.bytesIn", { bytes: formatBytes(inputBytes) }));
  if (card.elapsedMs > 0)
    parts.push(t("cardLabels.elapsedSec", { secs: (card.elapsedMs / 1000).toFixed(2) }));
  if (
    card.done &&
    !card.rejected &&
    !card.aborted &&
    card.exitCode !== undefined &&
    card.exitCode !== 0
  ) {
    parts.push(t("cardLabels.exit", { code: card.exitCode }));
  }
  return parts;
}

function formatArgsSummary(args: unknown): string {
  if (typeof args === "string") return args.length > 60 ? `${args.slice(0, 60)}…` : args;
  if (args && typeof args === "object") {
    const keys = Object.keys(args as Record<string, unknown>);
    if (keys.length === 0) return "";
    const first = keys[0]!;
    const value = (args as Record<string, unknown>)[first];
    if (typeof value === "string") {
      const trimmed = value.length > 40 ? `${value.slice(0, 40)}…` : value;
      return keys.length === 1 ? trimmed : `${trimmed}  +${keys.length - 1}`;
    }
    return keys.join(" ");
  }
  return "";
}

const INPUT_SIZE_THRESHOLD = 1024;

/** Largest string field on args, when above threshold. Surfaces input bulk for write_file (content), edit_file (replace), run_command (long stdin), etc. without per-tool special cases. */
export function largestStringInputBytes(args: unknown): number | null {
  let max = 0;
  if (typeof args === "string") {
    max = args.length;
  } else if (args && typeof args === "object") {
    for (const v of Object.values(args as Record<string, unknown>)) {
      if (typeof v === "string" && v.length > max) max = v.length;
    }
  }
  return max >= INPUT_SIZE_THRESHOLD ? max : null;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export interface FileRef {
  /** Relative path as it appears in the tool args. */
  path: string;
  /** 1-indexed line number, if the tool provides position info (e.g. read_file range). */
  line?: number;
}

/** File-modifying or file-viewing tools whose primary arg is a path. */
const FILE_PATH_TOOLS = new Set([
  "read_file",
  "edit_file",
  "write_file",
  "delete_file",
  "create_directory",
  "delete_directory",
  "get_symbols",
  "find_in_code",
]);

/** Extract a file reference (path + optional line) from parsed tool args.
 *  Returns `null` when the tool isn't file-oriented or args are unparseable. */
export function extractFileRef(name: string, args: unknown): FileRef | null {
  if (!FILE_PATH_TOOLS.has(name)) {
    // multi_edit: use the first edit's path
    if (name === "multi_edit") {
      if (args && typeof args === "object") {
        const edits = (args as Record<string, unknown>).edits;
        if (Array.isArray(edits) && edits.length > 0) {
          const first = edits[0];
          if (first && typeof first === "object") {
            const p = (first as Record<string, unknown>).path;
            if (typeof p === "string") return { path: p };
          }
        }
      }
      return null;
    }
    // move_file / copy_file: use source
    if (name === "move_file" || name === "copy_file") {
      if (args && typeof args === "object") {
        const source = (args as Record<string, unknown>).source;
        if (typeof source === "string") return { path: source };
      }
      return null;
    }
    return null;
  }

  if (!args || typeof args !== "object") return null;
  const rec = args as Record<string, unknown>;
  const path = rec.path;
  if (typeof path !== "string") return null;

  let line: number | undefined;
  // read_file supports `range` like "50-100" or "50-50"
  if (name === "read_file" && typeof rec.range === "string") {
    const first = rec.range.split("-")[0];
    const n = Number.parseInt(first ?? "", 10);
    if (Number.isFinite(n) && n > 0) line = n;
  }
  // get_symbols / find_in_code: path + optional line from args or result
  if (name === "get_symbols" || name === "find_in_code") {
    if (typeof rec.line === "number" && rec.line > 0) line = rec.line;
  }

  return { path, line };
}

/** Build an OSC8 `file://` URL from a FileRef and project root. */
function fileUrl(ref: FileRef, rootDir: string): string {
  const abs = resolvePath(rootDir, ref.path);
  // Use forward slashes for cross-platform URL compatibility.
  const normalized = abs.replace(/\\/g, "/");
  const line = ref.line ?? 1;
  return `file:///${normalized}:${line}`;
}
