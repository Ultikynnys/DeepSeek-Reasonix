/** MCP stdio = newline-delimited JSON-RPC; transport iface lets tests fake it without spawning. */

import { type ChildProcess, spawn } from "node:child_process";
import { killProcessTree } from "../tools/process-tree.js";
import { BaseMcpTransport } from "./base-transport.js";
import { syntheticRpcError } from "./transport-utils.js";
import type { JsonRpcMessage } from "./types.js";

export interface McpTransport {
  /** Send one JSON-RPC message. Resolves when the bytes are accepted. */
  send(message: JsonRpcMessage): Promise<void>;
  /** Async iterator over incoming messages. Ends when the connection closes. */
  messages(): AsyncIterableIterator<JsonRpcMessage>;
  /** Close the underlying resource (kill child process, close streams). */
  close(): Promise<void>;
}

export interface StdioTransportOptions {
  /** Argv to spawn. First element is the command. */
  command: string;
  args?: string[];
  /** Env overlay — merged over process.env unless replaceEnv=true. */
  env?: Record<string, string>;
  /** When true, only the env above is visible to the child. Default false. */
  replaceEnv?: boolean;
  /** CWD for the child. Default: process.cwd(). */
  cwd?: string;
  /** Default true on win32 to resolve `.cmd`/`.bat` wrappers (npx.cmd etc.). */
  shell?: boolean;
}

export class StdioTransport extends BaseMcpTransport implements McpTransport {
  private readonly child: ChildProcess;
  private stdoutBuffer = "";
  private stderrTail = "";

  constructor(opts: StdioTransportOptions) {
    super();
    const env = opts.replaceEnv ? { ...(opts.env ?? {}) } : { ...process.env, ...(opts.env ?? {}) };
    // Windows wraps binaries as .cmd/.bat shims (npx.cmd, pnpm.cmd, …).
    // child_process.spawn without shell:true can't resolve them, which
    // breaks `--mcp "npx -y some-server"` — the most common MCP setup.
    // Default shell:true on win32 and leave POSIX alone.
    const shell = opts.shell ?? process.platform === "win32";

    if (shell) {
      // Node's shell:true + args[] triggers DEP0190 because it concatenates
      // with spaces and doesn't quote args — unsafe if an arg contains
      // shell metacharacters. We build a single command line ourselves,
      // quoting ONLY the args (command stays bare so the shell's PATH /
      // PATHEXT lookup finds `npx` → `npx.cmd` on Windows).
      const line = [
        opts.command,
        ...(opts.args ?? []).map((a) => quoteArg(a, process.platform === "win32")),
      ].join(" ");
      this.child = spawn(line, [], {
        env,
        cwd: opts.cwd,
        stdio: ["pipe", "pipe", "pipe"],
        shell: true,
      });
    } else {
      this.child = spawn(opts.command, opts.args ?? [], {
        env,
        cwd: opts.cwd,
        stdio: ["pipe", "pipe", "pipe"],
      });
    }
    this.child.stdout!.setEncoding("utf8");
    this.child.stdout!.on("data", (chunk: string) => this.onStdout(chunk));
    this.child.stderr!.setEncoding("utf8");
    this.child.stderr!.on("data", (chunk: string) => this.onStderr(chunk));
    this.child.on("close", (code) => this.onClose(code));
    this.child.on("error", (err) => {
      // Surface spawn errors as a synthetic JsonRpcError so callers don't
      // hang on a stream that never emits anything.
      this.incoming.push(syntheticRpcError(`transport error: ${err.message}`));
    });
  }

  async send(message: JsonRpcMessage): Promise<void> {
    this.assertOpen("stdio");
    return new Promise((resolve, reject) => {
      const line = `${JSON.stringify(message)}\n`;
      this.child.stdin!.write(line, "utf8", (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  async close(): Promise<void> {
    if (!this.markClosed()) return;
    try {
      this.child.stdin!.end();
    } catch {
      /* already ended */
    }
    if (this.child.exitCode === null && !this.child.killed) {
      // With shell:true (the win32 default) the direct child is the `cmd.exe`
      // wrapper, so a plain child.kill() terminates the shell but ORPHANS the
      // real server it launched (e.g. `uv` -> `python`) - those survive and leak
      // across sessions. Kill the whole tree instead; fall back to the direct
      // child if we have no pid.
      // child.kill("SIGTERM") throws EINVAL on Windows; plain kill() can also
      // throw on failed spawns - swallow both.
      const directKill = () => {
        try {
          this.child.kill(process.platform === "win32" ? undefined : "SIGTERM");
        } catch {
          /* already exited or unsignallable */
        }
      };
      if (this.child.pid) {
        killProcessTree(this.child.pid, "SIGKILL", { fallback: directKill });
      } else {
        directKill();
      }
    }
  }

  /** Parse incoming stdout chunks into NDJSON messages. */
  private onStdout(chunk: string): void {
    this.stdoutBuffer += chunk;
    let newlineIdx: number;
    // biome-ignore lint/suspicious/noAssignInExpressions: idiomatic loop shape
    while ((newlineIdx = this.stdoutBuffer.indexOf("\n")) !== -1) {
      const line = this.stdoutBuffer.slice(0, newlineIdx).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newlineIdx + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line) as JsonRpcMessage;
        this.incoming.push(msg);
      } catch {
        // Malformed stdout lines are dropped — some servers emit startup
        // banners before the JSON-RPC loop begins. Surface only under
        // REASONIX_DEBUG_MCP=1; otherwise the noise corrupts the TUI render.
        if (process.env.REASONIX_DEBUG_MCP === "1") {
          process.stderr.write(`[mcp-stdio] dropped malformed line: ${line}\n`);
        }
      }
    }
  }

  // Python MCP SDK writes info logs (`server.py:534 ListPromptsRequest`)
  // to stderr — letting those through would corrupt the TUI render.
  private onStderr(chunk: string): void {
    this.stderrTail = `${this.stderrTail}${chunk}`.slice(-4000);
    if (process.env.REASONIX_DEBUG_MCP === "1") {
      process.stderr.write(chunk);
    }
  }

  private onClose(code?: number | null): void {
    const finalCode = code ?? this.child.exitCode;
    if (!this.closed && finalCode !== null && finalCode !== 0) {
      const detail = this.stderrTail.trim();
      const reason = formatServerExitReason(finalCode, detail);
      this.incoming.push(syntheticRpcError(reason));
    }
    this.markClosed();
  }
}

export function formatServerExitReason(finalCode: number, detail: string): string {
  if (!detail) return `server process exited with code ${finalCode}`;

  const nodeVerMatch = detail.match(/Node\.js\s+(v\d+\.\d+\.\d+)/i);
  const detectedVer = nodeVerMatch ? nodeVerMatch[1] : undefined;

  // Playwright requires Node.js >= 18.18; net.getDefaultAutoSelectFamilyAttemptTimeout is missing in older Node
  if (detail.includes("getDefaultAutoSelectFamilyAttemptTimeout")) {
    const verText = detectedVer ? ` (detected ${detectedVer})` : "";
    return `Node.js is outdated${verText}. Playwright requires Node.js >= 18.18 (Node.js 20 or 22 LTS recommended). Please update Node.js at https://nodejs.org or via your version manager (nvm/fnm).`;
  }

  // Engine requirement or version incompatibility
  if (
    /unsupported.*engine.*node/i.test(detail) ||
    /requires node(?:\.js)? (?:>=|\^|v)?\d+/i.test(detail)
  ) {
    const verText = detectedVer ? ` (detected ${detectedVer})` : "";
    return `Node.js is outdated${verText}. This server requires a newer Node.js runtime (Node.js 20 or 22 LTS recommended). Please update Node.js at https://nodejs.org.`;
  }

  return `server process exited with code ${finalCode}: ${detail}`;
}

export function quoteArg(s: string, windows: boolean): string {
  if (!windows) {
    // POSIX: single-quote, escape single quotes.
    return `'${s.replace(/'/g, "'\\''")}'`;
  }
  // cmd.exe: double-quote, escape internal quotes by doubling.
  return `"${s.replace(/"/g, '""')}"`;
}
