import { homedir } from "node:os";
import { join } from "node:path";

/** Expand a leading `~` to the user's home directory.
 *  `~` → home; `~/…` / `~\…` → home/…; `~user…` → home/user… (legacy join
 *  semantics, kept for parity with the shell-tools sensitive-path matcher).
 *  Any other path passes through unchanged. */
export function expandTilde(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/") || p.startsWith("~\\")) return join(homedir(), p.slice(2));
  if (p.startsWith("~")) return join(homedir(), p.slice(1));
  return p;
}
