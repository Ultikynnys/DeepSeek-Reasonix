// playwright-tooling-version: 3
// Reasonix playwright driver: drives the configured @playwright/mcp browser
// connection with no repo or npm dependencies.
//
// The server is PERSISTENT: the first invocation spawns it (HTTP transport on
// a localhost port) and records it in .server.json; later invocations reuse
// the same server + relay session, so the bridged tool set is created once
// and reused: no per-invocation spawns or connection churn.
//
// Usage:
//   node driver.mjs list                       # tabs listing (also the connection check)
//   node driver.mjs open <url>                 # new tab + listing
//   node driver.mjs call <tool> [jsonArgs]     # one tool call
//   node driver.mjs seq <steps.json | ->       # sequential steps: [{"tool":"...","args":{...}}, ...]
//   node driver.mjs --close-tabs-all <cmd>     # also close every tab in the group
//   node driver.mjs stop                       # end the persistent server (closes group tabs)
//
// Server args and environment come from mcpServers.playwright in ~/.reasonix/config.json.
// Read AGENTS.md next to this file before first use in a session.
//
// PLATFORM-MANAGED: this file is overwritten when Reasonix ships a newer
// playwright-tooling-version. Put agent extensions in SEPARATE files next to
// this one and document them in AGENTS.md (below the platform marker) — never
// edit this file by hand or your changes are lost on upgrade.
import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const argv = process.argv.slice(2);
const CLOSE_ALL = argv[0] === "--close-tabs-all";
if (CLOSE_ALL) argv.shift();
const [cmd, ...rest] = argv;
const TIMEOUT_MS = Number(process.env.DRIVER_TIMEOUT_MS ?? 30000);
const STATE_PATH = join(homedir(), ".reasonix", "tools", "playwright", ".server.json");

const cfgPath = join(homedir(), ".reasonix", "config.json");
const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
const spec = cfg?.mcpServers?.playwright;
if (!spec) {
  console.error("✗ no mcpServers.playwright entry in ~/.reasonix/config.json");
  process.exit(4);
}

function readState() {
  try {
    return JSON.parse(readFileSync(STATE_PATH, "utf8"));
  } catch {
    return null;
  }
}

function writeState(state) {
  writeFileSync(STATE_PATH, JSON.stringify(state), "utf8");
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Streamable-HTTP MCP call. Returns { ok, sid, result, text, isError, status }. */
async function httpRpc(port, sessionId, method, params, timeoutMs = TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    // NOTE: the server requires the URL to read `localhost` — it answers
    // 403 ("Access is only allowed at localhost:PORT") for any other Host,
    // and it binds ::1, so raw 127.0.0.1 is refused outright.
    const res = await fetch(`http://localhost:${port}/mcp`, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        ...(sessionId ? { "Mcp-Session-Id": sessionId } : {}),
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    const sid = res.headers.get("mcp-session-id") ?? sessionId ?? null;
    const text = await res.text();
    if (res.status === 404 || res.status === 400) {
      return { ok: false, status: res.status, sid, result: null, text, isError: false };
    }
    if (!res.ok) {
      return { ok: false, status: res.status, sid, result: null, text, isError: false };
    }
    // SSE body (event: message / data: {...}) or plain JSON — both appear.
    const dataLine = text.split("\n").filter((l) => l.startsWith("data:")).pop() ?? "";
    const payload = dataLine ? JSON.parse(dataLine.slice(5).trim()) : JSON.parse(text);
    const resultText = Array.isArray(payload.result?.content)
      ? payload.result.content
          .map((c) => (c && typeof c === "object" && "text" in c ? String(c.text) : ""))
          .join("\n")
      : JSON.stringify(payload.result ?? null);
    return { ok: true, status: res.status, sid, result: payload.result ?? null, text: resultText, isError: Boolean(payload.result?.isError) };
  } catch (err) {
    // Network errors (ECONNREFUSED = nothing listening) and timeouts are both
    // "not usable on this port" — the caller moves to the next candidate.
    const message = err?.cause?.message ?? err?.message ?? String(err);
    return { ok: false, status: 0, sid: sessionId ?? null, result: null, text: message, isError: false };
  } finally {
    clearTimeout(timer);
  }
}

/** Reuse the persistent server recorded in .server.json, adopt any running
 *  playwright HTTP server on the scanned ports, or spawn one detached. The
 *  returned session is reused by later invocations — tools are created once. */
async function ensureServer() {
  const INIT_PARAMS = {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "reasonix-playwright-driver", version: "1.0.0" },
  };
  const state = readState();
  const ports = [];
  if (state?.port) ports.push(state.port);
  const base = Number(process.env.DRIVER_PORT ?? 8931);
  for (let p = base; p < base + 10; p++) {
    if (!ports.includes(p)) ports.push(p);
  }

  // 1. Fast path: the stored relay session is still valid — no new session,
  //  no new client group, no connect-page tab. tools/list never touches the
  //  browser, so this probe is free.
  if (state?.port && state?.sessionId) {
    const probe = await httpRpc(state.port, state.sessionId, "tools/list", {}, 8000);
    if (probe.ok) return { port: state.port, sessionId: state.sessionId, reused: true, spawned: false };
  }

  // 2. Adopt a running Playwright HTTP server on a scanned port.
  const dead = [];
  for (const port of ports) {
    const init = await httpRpc(port, null, "initialize", INIT_PARAMS, 8000);
    if (init.ok && init.result?.serverInfo?.name === "Playwright") {
      await httpRpc(port, init.sid, "notifications/initialized", undefined, 5000);
      const pid = readState()?.pid ?? null;
      writeState({ ...(readState() ?? {}), port, sessionId: init.sid, pid });
      return { port, sessionId: init.sid, reused: false, spawned: false };
    }
    dead.push(port);
  }

  // 3. Spawn detached on a port that answered nothing — the child outlives
  //  this invocation (unref) so the next one attaches in milliseconds.
  //  windowsHide is non-negotiable on Windows: shell spawns flash a console
  //  per attempt otherwise. Direct node + the npx-cached cli.js is the
  //  primary form — no cmd wrapper at all, so no console and no npx wait.
  const debug = Boolean(process.env.DRIVER_DEBUG);
  const pkgDir = resolveNpxPackageDir("@playwright/mcp");
  if (debug) console.error(`[spawn] pkgDir=${pkgDir} dead=${dead[0]}`);
  // spec.args are NPX wrapper args: leading "-y" + the package spec, then the
  // server's own flags. The direct cli.js spawn drops the leading wrapper
  // args only — flag VALUES (e.g. "msedge") must survive, so no --filtering.
  const specArgs = spec.args ?? [];
  const firstFlag = specArgs.findIndex((a) => a.startsWith("--"));
  const stdioArgs = firstFlag >= 0 ? specArgs.slice(firstFlag) : [];
  const attempts = pkgDir
    ? [{ cmd: process.execPath, args: [join(pkgDir, "cli.js"), ...stdioArgs, "--port", String(dead[0])] }]
    : [{ cmd: [spec.command, ...stdioArgs, "--port", String(dead[0])].join(" "), shell: true }];
  for (const attempt of attempts) {
    const debug = Boolean(process.env.DRIVER_DEBUG);
    if (debug) console.error(`[spawn] cmd=${JSON.stringify(attempt.cmd)} args=${JSON.stringify(attempt.args)}`);
    const child = spawn(attempt.cmd, attempt.args ?? [], {
      env: { ...process.env, ...(spec.env ?? {}) },
      shell: Boolean(attempt.shell),
      detached: true,
      stdio: debug ? ["ignore", "pipe", "pipe"] : "ignore",
      windowsHide: true,
    });
    child.unref();
    if (debug) child.stderr?.on("data", (d) => console.error(`[server] ${String(d).trim().slice(0, 200)}`));
    child.on("error", (err) => console.error(`[server spawn error] ${err.message}`));
    for (let i = 0; i < 30; i++) {
      await sleep(500);
      const init = await httpRpc(dead[0], null, "initialize", INIT_PARAMS, 4000);
      if (debug) console.error(`[poll ${i}] ok=${init.ok} status=${init.status} text=${init.text.slice(0, 80)}`);
      if (init.ok && init.result?.serverInfo?.name === "Playwright") {
        await httpRpc(dead[0], init.sid, "notifications/initialized", undefined, 5000);
        writeState({ port: dead[0], pid: child.pid, sessionId: init.sid });
        return { port: dead[0], sessionId: init.sid, reused: false, spawned: true };
      }
      if (!existsProcess(child.pid)) break;
    }
    // Readiness failed — kill the child so nothing lingers, then fall through
    // to the shell fallback if there is one.
    killProcessTree(child.pid);
  }
  throw new Error("could not start the playwright HTTP server on an unused localhost port");
}

function existsProcess(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function killProcessTree(pid) {
  try {
    if (process.platform === "win32") {
      spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    } else {
      process.kill(pid, "SIGTERM");
    }
  } catch {
    // already gone
  }
}

/** Locate the npx-cached package dir (…/_npx/<hash>/node_modules/<pkg>) so the
 *  driver can spawn its cli.js directly — no cmd wrapper, no console flash. */
function resolveNpxPackageDir(pkg) {
  const parts = pkg.split("/");
  const cacheRoot = process.env.LOCALAPPDATA
    ? join(process.env.LOCALAPPDATA, "npm-cache", "_npx")
    : join(homedir(), ".npm", "_npx");
  try {
    for (const entry of readdirSync(cacheRoot)) {
      const candidate = join(cacheRoot, entry, "node_modules", ...parts);
      if (existsSync(join(candidate, "package.json"))) return candidate;
    }
  } catch {
    // no npx cache — caller falls back to the catalog command
  }
  return null;
}

async function callTool(name, args, timeoutMs = TIMEOUT_MS) {
  const { port, sessionId } = await ensureServer();
  let res = await httpRpc(port, sessionId, "tools/call", { name, arguments: args ?? {} }, timeoutMs);
  if (!res.ok) {
    // Session expired or the server died — ensureServer re-handshakes or
    // respawns, then the call retries once.
    const retry = await ensureServer();
    res = await httpRpc(retry.port, retry.sessionId, "tools/call", { name, arguments: args ?? {} }, timeoutMs);
  }
  if (!res.ok) throw new Error(`tools/call ${name}: HTTP ${res.status ?? "failed"}`);
  return { text: res.text, isError: res.isError };
}

let exitCode = 0;
try {
  if (cmd === "stop") {
    const state = readState();
    if (!state?.port) {
      console.log("no persistent server recorded — nothing to stop");
    } else {
      try {
        const tabs = await httpRpc(state.port, state.sessionId, "tools/call", {
          name: "browser_tabs",
          arguments: { action: "list" },
        }, 8000);
        const indexes = [...(tabs.text ?? "").matchAll(/^-\s*(\d+):/gm)].map((m) => Number(m[1]));
        for (const idx of indexes.reverse()) {
          try {
            await httpRpc(state.port, state.sessionId, "tools/call", {
              name: "browser_tabs",
              arguments: { action: "close", index: idx },
            }, 8000);
          } catch {
            // already closed
          }
        }
      } catch {
        // session already dead — the kill below is enough
      }
      killProcessTree(state.pid);
      rmSync(STATE_PATH, { force: true });
      console.log("server stopped, group tabs closed, state cleared");
    }
  } else if (cmd === "list" || cmd === "open" || cmd === "call" || cmd === "seq") {
    const t0 = Date.now();
    const { reused } = await ensureServer();
    console.log(`server ${reused ? "reused" : "started"} (${Date.now() - t0} ms)`);

    const run = async (tool, args, timeoutMs) => {
      const step = await callTool(tool, args, timeoutMs);
      console.log(`### ${tool}`);
      console.log(step.text.trim());
      return step;
    };

    if (cmd === "list") {
      const step = await run("browser_tabs", { action: "list" });
      if (step.isError) exitCode = 3;
    } else if (cmd === "open") {
      if (!rest[0]) {
        console.error("usage: driver.mjs open <url>");
        exitCode = 4;
      } else {
        const step = await run("browser_tabs", { action: "new", url: rest[0] });
        if (step.isError) exitCode = 3;
        else {
          await sleep(2000);
          console.log((await run("browser_tabs", { action: "list" })).text);
        }
      }
    } else if (cmd === "call") {
      if (!rest[0]) {
        console.error("usage: driver.mjs call <tool> [jsonArgs]");
        exitCode = 4;
      } else {
        let args = {};
        if (rest[1]) {
          try {
            args = JSON.parse(rest[1]);
          } catch {
            console.error(`✗ args are not valid JSON: ${rest[1]}`);
            exitCode = 4;
          }
        }
        const step = await run(rest[0], args);
        if (step.isError) exitCode = 3;
      }
    } else if (cmd === "seq") {
      if (!rest[0]) {
        console.error("usage: driver.mjs seq <steps.json | ->");
        exitCode = 4;
      } else {
        const raw = rest[0] === "-" ? readFileSync(0, "utf8") : readFileSync(rest[0], "utf8");
        const steps = JSON.parse(raw);
        if (!Array.isArray(steps)) throw new Error("seq steps must be a JSON array of {tool, args}");
        let i = 0;
        for (const s of steps) {
          const step = await run(s.tool, s.args, s.timeoutMs ?? TIMEOUT_MS);
          if (step.isError) {
            console.error(`✗ step ${i} (${s.tool}) returned isError — stopping seq`);
            exitCode = 3;
            break;
          }
          i++;
        }
        console.log(`seq: ${i}/${steps.length} steps completed`);
      }
    }
    if (CLOSE_ALL) {
      const tabs = await callTool("browser_tabs", { action: "list" });
      for (const idx of [...(tabs.text ?? "").matchAll(/^-\s*(\d+):/gm)].map((m) => Number(m[1])).reverse()) {
        try {
          await callTool("browser_tabs", { action: "close", index: idx }, 8000);
        } catch {
          // already closed
        }
      }
      console.log("teardown: all group tabs closed");
    }
  } else {
    console.error("usage: driver.mjs [--close-tabs-all] list | open <url> | call <tool> [jsonArgs] | seq <file|-> | stop");
    exitCode = 4;
  }
} catch (err) {
  const msg = err?.message ?? String(err);
  if (/timed out|aborted/i.test(msg)) {
    console.error(
      `✗ no browser responded within ${Math.round(TIMEOUT_MS / 1000)}s — the stored token is likely wrong, or Edge isn't running with the extension installed`,
    );
    exitCode = 2;
  } else {
    console.error(`✗ ${msg}`);
    exitCode = 1;
  }
}
// Natural exit, not process.exit: node's fetch keeps keep-alive sockets that
// libuv must close gracefully — a hard exit trips a uvwasi/libuv assert on
// Windows. The idle socket drains in a few seconds and the code still applies.
process.exitCode = exitCode;