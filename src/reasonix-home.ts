/** Canonical path to the Reasonix state directory: `~/.reasonix`. */

import { homedir } from "node:os";
import { join } from "node:path";

/** Returns `~/.reasonix` — the single source of truth for the Reasonix state directory. */
export function reasonixHome(): string {
  return join(homedir(), ".reasonix");
}
