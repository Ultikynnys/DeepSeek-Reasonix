function isWindowsPath(path: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(path) || path.includes("\\");
}

function normalizeForComparison(path: string): string {
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
  return isWindowsPath(path) ? normalized.toLowerCase() : normalized;
}

/** Resolve a workspace-relative path while preserving the workspace platform's separator. */
export function toWorkspaceAbsolute(path: string, workspaceDir?: string): string {
  if (!workspaceDir || /^[a-zA-Z]:[\\/]/.test(path) || path.startsWith("/") || path.startsWith("\\")) {
    return path;
  }
  const windows = isWindowsPath(workspaceDir);
  const separator = windows ? "\\" : "/";
  const base = workspaceDir.replace(/[\\/]+$/, "");
  const relative = path.replace(/^[\\/]+/, "").replace(/[\\/]/g, separator);
  return `${base}${separator}${relative}`;
}

/** Return a workspace-relative path only when the target is at or below the workspace boundary. */
export function toWorkspaceRelative(path: string, workspaceDir?: string): string {
  if (!workspaceDir) return path.replace(/\\/g, "/");
  const target = path.replace(/\\/g, "/");
  const workspace = workspaceDir.replace(/\\/g, "/").replace(/\/+$/, "");
  const targetComparable = normalizeForComparison(path);
  const workspaceComparable = normalizeForComparison(workspaceDir);
  if (targetComparable === workspaceComparable) return ".";
  if (!targetComparable.startsWith(`${workspaceComparable}/`)) return target;
  return target.slice(workspace.length).replace(/^\/+/, "") || ".";
}
