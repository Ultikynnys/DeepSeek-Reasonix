/** File-path-bearing tool calls whose `path` / `edits[].path` args put a file
 *  in the session's "Files in context" list. Single-sourced so the backend's
 *  compaction triage and the desktop panel derivation agree on the set. */
export const FILE_PATH_TOOLS = ["read_file", "write_file", "edit_file", "multi_edit"] as const;

export type FilePathTool = (typeof FILE_PATH_TOOLS)[number];

export function isFilePathTool(name: string): boolean {
  return (FILE_PATH_TOOLS as readonly string[]).includes(name);
}

/**
 * Extracts file-path references from a tool call's JSON args: the top-level
 * `path` plus every `edits[].path` (multi_edit). Name-agnostic — callers
 * decide which tools count (file-prune tracks refs from ANY tool, the
 * context-file list only from FILE_PATH_TOOLS). Returns [] for malformed /
 * empty args; duplicates are preserved for the caller to dedupe as needed.
 */
export function extractPathsFromArgs(rawArgs: string | null | undefined): string[] {
  if (typeof rawArgs !== "string" || rawArgs.length === 0) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawArgs);
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return [];
  const args = parsed as Record<string, unknown>;
  const out: string[] = [];
  if (typeof args.path === "string" && args.path.length > 0) out.push(args.path);
  if (Array.isArray(args.edits)) {
    for (const edit of args.edits) {
      if (!edit || typeof edit !== "object") continue;
      const p = (edit as Record<string, unknown>).path;
      if (typeof p === "string" && p.length > 0) out.push(p);
    }
  }
  return out;
}
