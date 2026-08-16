import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { resolve } from "node:path";
import type { Plugin } from "vite";
import { WebSocketServer, type WebSocket } from "ws";

/**
 * Browser dev bridge — replaces the Tauri Rust host for `dev:browser`.
 *
 * The desktop UI is a Tauri webview app: the Rust host (`desktop/src-tauri/src/rpc.rs`)
 * spawns the Node daemon (`reasonix desktop`), forwards its stdout lines to the
 * webview as `rpc:event` emissions, and writes `rpc_send` commands back to the
 * daemon's stdin. This plugin replicates that pipe in pure Node so the same
 * frontend runs in a plain browser tab:
 *
 *   daemon stdout ──> ws { event: "rpc:event", payload: { data } }
 *   daemon stderr ──> ws { event: "rpc:stderr", payload: { data } }
 *   daemon exit   ──> ws { event: "rpc:exit",   payload: { code } }
 *   ws { line }    ──> daemon stdin (one JSON-RPC command per line)
 *
 * Active only when REASONIX_BROWSER=1 (see scripts/dev-browser.mjs), so the
 * real `tauri dev` flow — whose beforeDevCommand runs plain `vite` — is
 * untouched.
 */
const BRIDGE_PORT = 1421;

export function browserBridge(): Plugin {
  return {
    name: "reasonix-browser-bridge",
    apply: "serve",
    configureServer(server) {
      if (process.env.REASONIX_BROWSER !== "1") return;

      // Mirror rpc.rs: the daemon runs with the repo root as cwd so its config
      // discovery (package.json, src/cli) matches the desktop app.
      const repoRoot = findRepoRoot(process.cwd());
      if (!repoRoot) {
        console.error("[browser-bridge] repo root not found (no package.json with src/cli) — daemon not started");
        return;
      }

      let child: ChildProcess | null = null;
      let stdinClosed = false;
      const clients = new Set<WebSocket>();

      const spawnDaemon = () => {
        const tsxCli = resolve(repoRoot, "node_modules/tsx/dist/cli.mjs");
        const entry = resolve(repoRoot, "src/cli/index.ts");
        const builtEntry = resolve(repoRoot, "dist/cli/index.js");
        const useTsx = existsSync(tsxCli) && existsSync(entry);
        const program = useTsx ? process.execPath : process.execPath;
        const args = useTsx
          ? [tsxCli, entry, "desktop"]
          : [builtEntry, "desktop"];
        if (!useTsx && !existsSync(builtEntry)) {
          console.error(
            "[browser-bridge] neither src/cli/index.ts (tsx) nor dist/cli/index.js (build) found — run `npm run build` at the repo root",
          );
          return;
        }
        stdinClosed = false;
        child = spawn(program, args, {
          cwd: repoRoot,
          stdio: ["pipe", "pipe", "pipe"],
          windowsHide: true,
        });
        console.log(`[browser-bridge] daemon spawned (pid ${child.pid ?? "?"})`);

        const writeLine = (ws: WebSocket, event: string, data: unknown) => {
          if (ws.readyState === ws.OPEN) {
            ws.send(JSON.stringify({ event, payload: { data } }));
          }
        };
        const broadcast = (event: string, data: unknown) => {
          for (const ws of clients) writeLine(ws, event, data);
        };

        if (child.stdout) {
          const rl = createInterface({ input: child.stdout });
          rl.on("line", (line) => broadcast("rpc:event", line));
        }
        if (child.stderr) {
          const rl = createInterface({ input: child.stderr });
          rl.on("line", (line) => broadcast("rpc:stderr", line));
        }
        child.on("error", (err) => {
          console.error("[browser-bridge] daemon error", err);
          broadcast("rpc:exit", { code: null });
        });
        child.on("exit", (code) => {
          console.log(`[browser-bridge] daemon exited (code ${code ?? "?"})`);
          child = null;
          broadcast("rpc:exit", { code });
        });
      };

      const writeToStdin = (line: string) => {
        if (!child || stdinClosed || !child.stdin) {
          console.warn("[browser-bridge] rpc_send before daemon ready — dropped", line.slice(0, 120));
          return;
        }
        try {
          child.stdin.write(`${line}\n`);
        } catch (err) {
          console.error("[browser-bridge] stdin write failed", err);
        }
      };

      const killDaemon = () => {
        if (!child || !child.pid) return;
        // Closing stdin trips the daemon's readline close → graceful shutdown,
        // mirroring rpc.rs. Then tree-kill any survivors (taskkill on Windows,
        // pkill -P on POSIX) so dev grandchildren don't outlive vite.
        try {
          child.stdin?.end();
        } catch {
          /* already closed */
        }
        const pid = child.pid;
        const started = Date.now();
        const timer = setInterval(() => {
          if (!child) {
            clearInterval(timer);
            return;
          }
          if (Date.now() - started > 2000) {
            clearInterval(timer);
            if (process.platform === "win32") {
              spawn("taskkill", ["/F", "/T", "/PID", String(pid)], {
                windowsHide: true,
                stdio: "ignore",
              });
            } else {
              spawn("kill", ["-KILL", String(pid)], { stdio: "ignore" });
              spawn("pkill", ["-KILL", "-P", String(pid)], { stdio: "ignore" });
            }
          }
        }, 100);
      };

      const wss = new WebSocketServer({ port: BRIDGE_PORT, host: "127.0.0.1" });
      wss.on("listening", () => {
        console.log(`[browser-bridge] ws ready at ws://127.0.0.1:${BRIDGE_PORT}`);
      });
      wss.on("error", (err) => {
        console.error("[browser-bridge] ws server error", err);
      });
      wss.on("connection", (ws) => {
        clients.add(ws);
        console.log("[browser-bridge] client connected");
        ws.on("message", (raw) => {
          let msg: { type?: string; line?: string };
          try {
            msg = JSON.parse(String(raw)) as { type?: string; line?: string };
          } catch {
            return;
          }
          if (msg.type === "rpc_send" && typeof msg.line === "string") {
            writeToStdin(msg.line);
          } else if (msg.type === "rpc_kill") {
            killDaemon();
          }
        });
        ws.on("close", () => {
          clients.delete(ws);
        });
      });

      spawnDaemon();

      // Teardown with the dev server (Ctrl+C on dev:browser, vite restart).
      server.httpServer?.once("close", () => {
        killDaemon();
        wss.close();
      });
    },
  };
}

/** Walk up from `start` to the directory holding package.json + src/cli. */
function findRepoRoot(start: string): string | null {
  let dir = resolve(start);
  // eslint-disable-next-line no-constant-condition
  for (;;) {
    const pkg = resolve(dir, "package.json");
    if (existsSync(pkg) && existsSync(resolve(dir, "src/cli"))) {
      return dir;
    }
    const parent = resolve(dir, "..");
    if (parent === dir) return null;
    dir = parent;
  }
}
