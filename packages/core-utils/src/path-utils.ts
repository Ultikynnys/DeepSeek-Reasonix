/** Sandbox path-containment helpers — node:path-dependent, so they live in
 *  their own module: core-utils' root index must stay browser-bundle-safe,
 *  and desktop consumers never touch these (subpath import only). */

import { isAbsolute, relative } from "node:path";

/** True when `child` is `parent` itself or lexically inside it. Single source
 *  for every sandbox-containment check (edit gate, filesystem tools, shell
 *  redirects) — a copy that drifts here is a sandbox escape waiting to happen. */
export function pathIsUnder(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** Windows drive-letter prefixes always count; POSIX absolutes only count when
 *  their first segment is a known system root. */
export function looksLikeAbsoluteSystemPath(raw: string): boolean {
  if (/^[A-Za-z]:[\\/]/.test(raw)) return true;
  return /^\/(?:home|Users|etc|var|opt|tmp|usr|mnt|Library|Volumes|proc|sys|dev|run|srv|media|Applications|System|root|boot|private)(?:[/\\]|$)/.test(
    raw,
  );
}
