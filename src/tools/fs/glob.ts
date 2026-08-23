import { promises as fs } from "node:fs";
import picomatch from "picomatch";
import { displayRel } from "./rel.js";
import { walkDir } from "./walk.js";

export interface GlobContext {
  rootDir: string;
  skipDirNames: ReadonlySet<string>;
}

export async function globFiles(
  ctx: GlobContext,
  startAbs: string,
  args: {
    pattern: string;
    sort_by?: "mtime" | "name";
    include_deps?: boolean;
    limit?: number;
    signal?: AbortSignal;
  },
): Promise<string> {
  const includeDeps = args.include_deps === true;
  const sortBy = args.sort_by ?? "mtime";
  const limit = Math.max(1, Math.min(1000, Math.floor(args.limit ?? 200)));
  const isMatch = picomatch(args.pattern, { dot: true, nocase: true });

  const hits: { rel: string; mtimeMs: number }[] = [];
  await walkDir(
    startAbs,
    {
      includeDeps,
      skipDirNames: ctx.skipDirNames,
      signal: args.signal,
      label: "glob",
    },
    async (entry) => {
      if (!entry.dirent.isFile() && !entry.dirent.isSymbolicLink()) return true;
      const rel = displayRel(ctx.rootDir, entry.full);
      if (!isMatch(rel)) return true;
      let mtimeMs = 0;
      if (sortBy === "mtime") {
        try {
          const st = await fs.stat(entry.full);
          mtimeMs = st.mtimeMs;
        } catch {
          return true;
        }
      }
      hits.push({ rel, mtimeMs });
      return true;
    },
  );

  if (hits.length === 0) return "(no matches)";
  if (sortBy === "mtime") hits.sort((a, b) => b.mtimeMs - a.mtimeMs);
  else hits.sort((a, b) => a.rel.localeCompare(b.rel));

  const truncated = hits.length > limit;
  const shown = hits.slice(0, limit);
  const lines = shown.map((h) => h.rel);
  if (truncated) {
    lines.push(
      `[… ${hits.length - limit} more matches — refine pattern or raise limit (max 1000) …]`,
    );
  }
  return lines.join("\n");
}
