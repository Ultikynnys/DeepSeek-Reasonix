import * as pathMod from "node:path";

/** Workspace-relative display path with forward slashes — stable across platforms for tool results and prefix hashing. */
export function displayRel(rootDir: string, full: string): string {
  return pathMod.relative(rootDir, full).replaceAll("\\", "/");
}
