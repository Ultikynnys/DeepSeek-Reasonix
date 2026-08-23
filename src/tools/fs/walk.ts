import { promises as fs } from "node:fs";
import * as pathMod from "node:path";

/** Throw a user-abort DOMException when the signal is aborted. Shared by the
 *  filesystem walkers so the abort path stays uniform across glob/search. */
export function throwIfAborted(signal: AbortSignal | undefined, label = "search"): void {
  if (!signal?.aborted) return;
  throw new DOMException(`${label} aborted by user`, "AbortError");
}

export interface WalkDirEntry {
  dirent: import("node:fs").Dirent;
  /** Absolute path of the entry. */
  full: string;
}

export interface WalkDirOptions {
  /** Depth-first recursion into matching subdirectories. */
  includeDeps: boolean;
  /** Directory names skipped at every level when !includeDeps. */
  skipDirNames: ReadonlySet<string>;
  signal?: AbortSignal;
  /** Value for the DOMException message on abort — e.g. "glob" / "search". */
  label: string;
  /** Return false to stop the walk entirely (truncation, budget, etc.). */
  shouldStop?: () => boolean;
}

/** Recursively walk `startAbs`, visiting each non-directory entry. The
 *  readdir try/catch, dep-skip rule, and abort check are the shared skeleton
 *  that globFiles / searchFiles / searchContent each re-implemented. */
export async function walkDir(
  startAbs: string,
  opts: WalkDirOptions,
  visit: (entry: WalkDirEntry) => boolean | Promise<boolean>,
): Promise<void> {
  throwIfAborted(opts.signal, opts.label);
  if (opts.shouldStop?.()) return;
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(startAbs, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    throwIfAborted(opts.signal, opts.label);
    if (opts.shouldStop?.()) return;
    const full = pathMod.join(startAbs, e.name);
    if (e.isDirectory()) {
      if (!opts.includeDeps && opts.skipDirNames.has(e.name)) continue;
      await walkDir(full, opts, visit);
      continue;
    }
    const keepGoing = await visit({ dirent: e, full });
    if (keepGoing === false) return;
  }
}
