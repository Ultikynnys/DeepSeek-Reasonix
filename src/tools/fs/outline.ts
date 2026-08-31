/** Per-language top-level symbol outline for read_file preview. Regex-anchored at column 0 — nested decls intentionally skipped. */

import * as pathMod from "node:path";

export type OutlineEntry = { line: number; text: string };

const OUTLINE_MAX_ENTRIES = 30;
const OUTLINE_TAIL_KEEP = 5;

const TS_EXPORT_RE =
  /^export\s+(?:default\s+)?(?:async\s+)?(function|class|const|let|var|interface|type|enum)\s+\*?\s*(\w+)/;

const PY_DECL_RE = /^(?:async\s+)?(def|class)\s+(\w+)/;

const GO_DECL_RE = /^(func|type|var|const)\s+(?:\([^)]+\)\s+)?(\w+)/;

const RUST_DECL_RE =
  /^(?:pub(?:\([^)]+\))?\s+)?(?:async\s+)?(?:unsafe\s+)?(fn|struct|enum|trait|mod|type|const|static|union)\s+(\w+)/;

const RUST_IMPL_RE = /^(?:unsafe\s+)?impl(?:\s*<[^>]+>)?\s+(?:[^{]+\s+for\s+)?(\w+)/;

const MD_HEADING_RE = /^(#{1,6})\s+(.+?)\s*$/;

const MD_FENCE_RE = /^```/;

const PROTO_TOP_RE = /^(message|service|enum|extend)\s+(\w+)/;

const PROTO_RPC_RE = /^\s+rpc\s+(\w+)/;

const CN_NUM = "[\\d零一二三四五六七八九十百千万０-９]+";

const TXT_CHAPTER_PATTERNS: readonly RegExp[] = [
  new RegExp(`^第${CN_NUM}[章节回].{0,80}$`),
  new RegExp(`^卷${CN_NUM}.{0,80}$`),
  /^(?:序章|楔子|番外篇?|前言|后记|尾声|引子)(?:[\s\u3000：:、—\-.].{0,80})?$/,
  /^Chapter\s+(?:\d+|[IVXLCDMivxlcdm]+|[A-Za-z]+)\b.{0,80}$/,
  /^CHAPTER\s+.{1,80}$/,
  /^Part\s+(?:\d+|[IVXLCDMivxlcdm]+)\b.{0,80}$/,
  /^PART\s+.{1,80}$/,
];

type Lang = "ts" | "py" | "go" | "rust" | "md" | "proto" | "txt";

const EXT_TO_LANG: Record<string, Lang> = {
  ".ts": "ts",
  ".tsx": "ts",
  ".mts": "ts",
  ".cts": "ts",
  ".js": "ts",
  ".jsx": "ts",
  ".mjs": "ts",
  ".cjs": "ts",
  ".py": "py",
  ".pyi": "py",
  ".go": "go",
  ".rs": "rust",
  ".md": "md",
  ".markdown": "md",
  ".mdx": "md",
  ".proto": "proto",
  ".txt": "txt",
  ".text": "txt",
};

export function extractOutline(filename: string, lines: readonly string[]): OutlineEntry[] {
  const collector = createOutlineCollector(filename);
  for (let i = 0; i < lines.length; i++) collector.visit(lines[i]!, i + 1);
  return collector.entries;
}

/** Incremental outline collector used by streaming read_file previews. */
export function createOutlineCollector(filename: string): {
  visit: (line: string, lineNo: number) => void;
  entries: OutlineEntry[];
} {
  const ext = pathMod.extname(filename).toLowerCase();
  const lang = EXT_TO_LANG[ext];
  const entries: OutlineEntry[] = [];
  let inMarkdownFence = false;
  const visit = (line: string, lineNo: number): void => {
    let text: string | null = null;
    switch (lang) {
      case "ts": {
        if (!line.startsWith("export ")) break;
        const match = TS_EXPORT_RE.exec(line);
        if (match) text = `export ${match[1]} ${match[2]}`;
        break;
      }
      case "py": {
        if (line.startsWith(" ") || line.startsWith("\t")) break;
        const match = PY_DECL_RE.exec(line);
        if (match) text = `${match[1]} ${match[2]}`;
        break;
      }
      case "go": {
        if (line.startsWith(" ") || line.startsWith("\t")) break;
        const match = GO_DECL_RE.exec(line);
        if (match) text = `${match[1]} ${match[2]}`;
        break;
      }
      case "rust": {
        if (line.startsWith(" ") || line.startsWith("\t")) break;
        const implMatch = RUST_IMPL_RE.exec(line);
        if (implMatch) text = `impl ${implMatch[1]}`;
        else {
          const match = RUST_DECL_RE.exec(line);
          if (match) text = `${match[1]} ${match[2]}`;
        }
        break;
      }
      case "md": {
        if (MD_FENCE_RE.test(line)) {
          inMarkdownFence = !inMarkdownFence;
          break;
        }
        if (inMarkdownFence) break;
        const match = MD_HEADING_RE.exec(line);
        if (match) text = `${match[1]} ${match[2]}`;
        break;
      }
      case "proto": {
        if (!line.startsWith(" ") && !line.startsWith("\t")) {
          const match = PROTO_TOP_RE.exec(line);
          if (match) text = `${match[1]} ${match[2]}`;
        }
        if (text === null) {
          const rpc = PROTO_RPC_RE.exec(line);
          if (rpc) text = `rpc ${rpc[1]}`;
        }
        break;
      }
      case "txt": {
        const trimmed = line.trim();
        if (trimmed.length === 0 || trimmed.length > 100) break;
        if (TXT_CHAPTER_PATTERNS.some((pattern) => pattern.test(trimmed))) text = trimmed;
        break;
      }
    }
    if (text !== null) entries.push({ line: lineNo, text });
  };
  return { visit, entries };
}

export function formatOutline(entries: readonly OutlineEntry[]): string {
  const total = entries.length;
  if (total === 0) return "";
  const lastEntry = entries[total - 1]!;
  const width = String(lastEntry.line).length;
  const fmt = (e: OutlineEntry) => `  L${String(e.line).padStart(width, " ")}  ${e.text}`;
  const header = `[outline: ${total} symbol${total === 1 ? "" : "s"}]`;
  if (total <= OUTLINE_MAX_ENTRIES) {
    return [header, ...entries.map(fmt)].join("\n");
  }
  const headCount = OUTLINE_MAX_ENTRIES - OUTLINE_TAIL_KEEP;
  const headEntries = entries.slice(0, headCount);
  const tailEntries = entries.slice(-OUTLINE_TAIL_KEEP);
  const omitted = total - OUTLINE_MAX_ENTRIES;
  const gapStart = headEntries[headEntries.length - 1]!.line;
  const gapEnd = tailEntries[0]!.line;
  return [
    header,
    ...headEntries.map(fmt),
    `  [… ${omitted} more symbol${omitted === 1 ? "" : "s"} between L${gapStart} and L${gapEnd} …]`,
    ...tailEntries.map(fmt),
  ].join("\n");
}
