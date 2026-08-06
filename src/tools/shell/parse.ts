import * as pathMod from "node:path";
import { expandTilde } from "@reasonix/core-utils/expand-tilde";
import { pathIsUnder } from "@reasonix/core-utils/path-utils";
import { splitShellTokens } from "../../mcp/shell-split.js";
import {
  type CommandChain,
  chainAllowed,
  isNullDeviceAlias,
  parseCommandChain,
} from "../shell-chain.js";

/** Read-only reports + test runners whose failure mode is "exit 1 with output". */
export const BUILTIN_ALLOWLIST: ReadonlyArray<string> = [
  // Repo inspection
  "git status",
  "git diff",
  "git log",
  "git show",
  "git blame",
  "git branch",
  "git remote",
  "git rev-parse",
  "git config --get",
  // Filesystem inspection
  "ls",
  "pwd",
  "cat",
  "head",
  "tail",
  "wc",
  "file",
  "tree",
  "find",
  "grep",
  "rg",
  // Language version probes
  "node --version",
  "node -v",
  "npm --version",
  "npx --version",
  "python --version",
  "python3 --version",
  "cargo --version",
  "go version",
  "rustc --version",
  "deno --version",
  "bun --version",
  // Test runners (non-destructive by convention)
  "npm test",
  "npm run test",
  "npx vitest run",
  "npx vitest",
  "npx jest",
  "pytest",
  "python -m pytest",
  "cargo test",
  "cargo check",
  "cargo clippy",
  "go test",
  "go vet",
  "deno test",
  "bun test",
  // Linters / typecheckers (read-only by convention)
  "npm run lint",
  "npm run typecheck",
  "npx tsc --noEmit",
  "npx biome check",
  "npx eslint",
  "npx prettier --check",
  "ruff",
  "mypy",
];

/** No env / glob / backtick / `$(…)` expansion — prevents bypass of allowlist via concatenation. */
export function tokenizeCommand(cmd: string): string[] {
  const r = splitShellTokens(cmd, "quote-and-backslash");
  if ("unterminated" in r) throw new Error(`unclosed ${r.unterminated} in command`);
  return r.tokens.map((t) => t.text);
}

/** Up-front detection — without it, `dir | findstr foo` quotes `|` literal and pipe silently fails. */
const OP_PREFIX = /^(?:2>&1|&>|\|{1,2}|&{1,2}|2>{1,2}|>{1,2}|<{1,2})/;

export function detectShellOperator(cmd: string): string | null {
  const r = splitShellTokens(cmd, "quote-and-backslash");
  if ("unterminated" in r) return null; // let tokenizeCommand throw the unclosed-quote error
  for (const tok of r.tokens) {
    if (tok.quoted) continue;
    const m = OP_PREFIX.exec(tok.text);
    if (m) return m[0] ?? null;
  }
  return null;
}

export { isDqEscape } from "../../mcp/shell-split.js";

/** Per-prefix demotion: an otherwise-allowlisted match falls back to the confirm gate when one of these tokens appears in the tail. Issue #257: `git branch -D` skipped review. Each token also matches its `--flag=value` form. */
const RISKY_ARGS: Readonly<Record<string, ReadonlyArray<string>>> = {
  // Branch / remote mutation
  "git branch": ["-d", "-D", "--delete", "-m", "-M", "--move", "-c", "-C", "--copy", "--force"],
  "git remote": ["add", "remove", "rm", "rename", "set-url", "set-head", "prune"],
  // `--output` writes to an arbitrary path; `--ext-diff` invokes user-config'd external programs.
  "git diff": ["--output", "--ext-diff"],
  "git log": ["--output"],
  "git show": ["--output"],
  // `-exec*` / `-ok*` are RCE; `-delete` and `-fprint*` / `-fls` write to arbitrary paths.
  find: [
    "-delete",
    "-exec",
    "-execdir",
    "-ok",
    "-okdir",
    "-fprint",
    "-fprint0",
    "-fprintf",
    "-fls",
  ],
  // `-o FILE` writes the tree to an arbitrary path.
  tree: ["-o"],
  // Auto-fix mutates source files.
  "npx eslint": ["--fix", "--fix-dry-run"],
  "npx biome check": ["--write", "--apply", "--apply-unsafe"],
  ruff: ["--fix", "--unsafe-fixes", "format"],
};

function tailHasRisky(tail: readonly string[], risky: readonly string[]): boolean {
  for (const a of tail) {
    for (const r of risky) {
      if (a === r) return true;
      if (a.startsWith(`${r}=`)) return true;
    }
  }
  return false;
}

/** Issue #259 — default sensitive-path prefixes (tilde-relative). Matching a path argument against these
 *  demotes an otherwise-allowlisted command back to the confirm gate, preventing the agent from
 *  silently reading credentials / keys and piping them into the LLM context. */
const DEFAULT_SENSITIVE_PREFIXES: ReadonlyArray<string> = [
  "~/.ssh",
  "~/.aws",
  "~/.gnupg",
  "~/.kube",
  "/etc/shadow",
  "/etc/sudoers",
];

/** Issue #259 — filename patterns (case-insensitive basename match). */
const DEFAULT_SENSITIVE_PATTERNS: ReadonlyArray<string> = [
  "*.env",
  "*.env.*",
  "*.key",
  "*.pem",
  "id_rsa*",
  "id_ed25519*",
  "*credentials*",
  "*secret*",
];

/** Resolve `~` to `homedir()` and normalize. Non-path-like tokens (flags, URLs, env vars) are skipped. */
function resolveSensitivePath(token: string, projectRoot: string): string | null {
  if (!token || token.startsWith("-") || token.includes("://") || token.startsWith("$"))
    return null;
  let expanded = token;
  if (expanded.startsWith("~")) {
    expanded = expandTilde(expanded);
  }
  return pathMod.resolve(projectRoot, expanded);
}

function expandPrefix(prefix: string): string {
  if (prefix.startsWith("~")) return expandTilde(prefix);
  return pathMod.resolve(prefix);
}

/** Ensure prefix matches only at directory boundaries (not mid-segment). */
function pathStartsWithPrefix(normalized: string, prefix: string): boolean {
  return normalized === prefix || normalized.startsWith(`${prefix}${pathMod.sep}`);
}

/** Glob-style match: `*.env` matches `foo.env`, `id_rsa*` matches `id_rsa_old`. */
function matchesGlob(name: string, pattern: string): boolean {
  const regex = new RegExp(
    `^${pattern
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replace(/\*/g, ".*")
      .replace(/\?/g, ".")}$`,
    "i",
  );
  return regex.test(name);
}

/** Check whether a command's path-like arguments touch sensitive locations. */
export function hasSensitivePathArgs(
  argv: readonly string[],
  projectRoot: string,
  extraPrefixes: readonly string[] = [],
  extraPatterns: readonly string[] = [],
): boolean {
  const prefixes = [...DEFAULT_SENSITIVE_PREFIXES, ...extraPrefixes].map(expandPrefix);
  const patterns = [...DEFAULT_SENSITIVE_PATTERNS, ...extraPatterns];
  for (const token of argv) {
    const resolved = resolveSensitivePath(token, projectRoot);
    if (!resolved) continue;
    const normalized = pathMod.normalize(resolved);
    for (const pfx of prefixes) {
      if (pathStartsWithPrefix(normalized, pfx)) return true;
    }
    const base = pathMod.basename(normalized);
    for (const pat of patterns) {
      if (matchesGlob(base, pat)) return true;
    }
  }
  return false;
}

function redirectTargets(chain: CommandChain): string[] {
  const targets: string[] = [];
  for (const seg of chain.segments) {
    for (const r of seg.redirects) {
      if (r.kind === "2>&1" || !r.target || isNullDeviceAlias(r.target)) continue;
      targets.push(r.target);
    }
  }
  return targets;
}

export function redirectsEscapeSandbox(chain: CommandChain, projectRoot: string): boolean {
  const root = pathMod.resolve(projectRoot);
  for (const target of redirectTargets(chain)) {
    const resolved = pathMod.resolve(root, target);
    if (!pathIsUnder(resolved, root)) return true;
  }
  return false;
}

/** Allowlist match on leading argv tokens; demoted by `RISKY_ARGS` when a destructive flag appears in the tail,
 *  or by `SENSITIVE_PATHS` when a path argument targets a sensitive location (#259). */
export function isAllowed(
  cmd: string,
  extra: readonly string[] = [],
  projectRoot?: string,
  sensitivePathConfig?: { prefixes?: readonly string[]; patterns?: readonly string[] },
): boolean {
  let argv: string[];
  try {
    argv = tokenizeCommand(cmd);
  } catch {
    return false;
  }
  if (argv.length === 0) return false;

  const allowlist = [...BUILTIN_ALLOWLIST, ...extra];
  for (const prefix of allowlist) {
    const prefixTokens = prefix.split(" ");
    if (argv.length < prefixTokens.length) continue;
    let match = true;
    for (let i = 0; i < prefixTokens.length; i++) {
      if (argv[i] !== prefixTokens[i]) {
        match = false;
        break;
      }
    }
    if (!match) continue;

    const risky = RISKY_ARGS[prefix];
    if (risky && tailHasRisky(argv.slice(prefixTokens.length), risky)) return false;
    if (
      projectRoot &&
      hasSensitivePathArgs(
        argv,
        projectRoot,
        sensitivePathConfig?.prefixes,
        sensitivePathConfig?.patterns,
      )
    )
      return false;
    return true;
  }
  return false;
}

/** For chain commands, every segment must individually clear the allowlist. */
export function isCommandAllowed(
  cmd: string,
  extra: readonly string[] = [],
  projectRoot?: string,
  sensitivePathConfig?: { prefixes?: readonly string[]; patterns?: readonly string[] },
): boolean {
  let chain: CommandChain | null;
  try {
    chain = parseCommandChain(cmd);
  } catch {
    return false;
  }
  if (chain === null) return isAllowed(cmd, extra, projectRoot, sensitivePathConfig);
  const targets = redirectTargets(chain);
  if (targets.length > 0 && !projectRoot) return false;
  if (projectRoot) {
    if (redirectsEscapeSandbox(chain, projectRoot)) return false;
    if (
      hasSensitivePathArgs(
        targets,
        projectRoot,
        sensitivePathConfig?.prefixes,
        sensitivePathConfig?.patterns,
      )
    )
      return false;
  }
  return chainAllowed(chain, (seg) => isAllowed(seg, extra, projectRoot, sensitivePathConfig));
}

export { derivePrefix } from "@reasonix/core-utils";
