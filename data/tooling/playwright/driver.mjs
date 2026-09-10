// playwright-tooling-version: 1
// Reasonix playwright driver — drives the user's real browser through the
// @playwright/mcp extension relay, with no repo or npm dependencies.
//
// Usage:
//   node driver.mjs list                       # tabs listing (also the connection check)
//   node driver.mjs open <url>                 # new tab + listing
//   node driver.mjs call <tool> [jsonArgs]     # one tool call
//   node driver.mjs seq <steps.json | ->       # sequential steps: [{"tool":"...","args":{...}}, ...]
//   node driver.mjs --close-tabs-all <cmd>     # also close every tab in the group at teardown
//
// Server + token come from mcpServers.playwright in ~/.reasonix/config.json.
// Read AGENTS.md next to this file before first use in a session.
//
// PLATFORM-MANAGED: this file is overwritten when Reasonix ships a newer
// playwright-tooling-version. Put agent extensions in SEPARATE files next to
// this one and document them in AGENTS.md (below the platform marker) — never
// edit this file by hand or your changes are lost on upgrade.
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

const argv = process.argv.slice(2);
const CLOSE_ALL = argv[0] === "--close-tabs-all";
if (CLOSE_ALL) argv.shift();
const [cmd, ...rest] = argv;
const TIMEOUT_MS = Number(process.env.DRIVER_TIMEOUT_MS ?? 30000);

const cfgPath = join(homedir(), ".reasonix", "config.json");
const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
const spec = cfg?.mcpServers?.playwright;
if (!spec) {
  console.error("✗ no mcpServers.playwright entry in ~/.reasonix/config.json");
  process.exit(4);
}

// Windows wraps npx as a .cmd shim → needs shell:true; passing args + shell
// together is DEP0190-deprecated, so on Windows the line is pre-joined.
const isWindows = process.platform === "win32";
const child = isWindows
  ? spawn([spec.command, ...(spec.args ?? [])].join(" "), {
      env: { ...process.env, ...(spec.env ?? {}) },
      shell: true,
      stdio: ["pipe", "pipe", "pipe"],
    })
  : spawn(spec.command, spec.args ?? [], {
      env: { ...process.env, ...(spec.env ?? {}) },
      stdio: ["pipe", "pipe", "pipe"],
    });
child.on("error", (err) => {
  console.error(`✗ server spawn failed: ${err.message}`);
  process.exit(3);
});
child.stderr.on("data", (d) => {
  const s = String(d).trim();
  if (s) console.error(`[server] ${s.slice(0, 300)}`);
});

const pending = new Map();
let nextId = 1;
createInterface({ input: child.stdout }).on("line", (line) => {
  const t = line.trim();
  if (!t.startsWith("{")) return; // banners / non-JSON noise
  let msg;
  try {
    msg = JSON.parse(t);
  } catch {
    return;
  }
  if (msg.id !== undefined && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(JSON.stringify(msg.error)));
    else resolve(msg.result);
  }
});

function request(method, params, timeoutMs = TIMEOUT_MS) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`${method} timed out after ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);
    pending.set(id, {
      resolve: (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      reject: (e) => {
        clearTimeout(timer);
        reject(e);
      },
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
}

function resultText(res) {
  return Array.isArray(res?.content)
    ? res.content.map((c) => (c && typeof c === "object" && "text" in c ? String(c.text) : "")).join("\n")
    : JSON.stringify(res);
}

async function callTool(name, args, timeoutMs = TIMEOUT_MS) {
  const res = await request("tools/call", { name, arguments: args ?? {} }, timeoutMs);
  const text = resultText(res);
  return { text, isError: Boolean(res?.isError) };
}

/** Tool results embed returned strings as JSON values — emitted objects are
 *  backslash-escaped (\"key\":1). Unescape before parsing. */
export function extractJson(text) {
  const raw = text.match(/\{[^\n]+\}/)?.[0] ?? "{}";
  return JSON.parse(raw.replace(/\\"/g, '"'));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let exitCode = 0;
try {
  await request(
    "initialize",
    {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "reasonix-playwright-driver", version: "1.0.0" },
    },
    20000,
  );
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);

  const t0 = Date.now();
  const run = async (tool, args, timeoutMs) => {
    const step = await callTool(tool, args, timeoutMs);
    console.log(`### ${tool} (${Date.now() - t0} ms elapsed)`);
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
          process.exit(4);
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
  } else {
    console.error("usage: driver.mjs [--close-tabs-all] list | open <url> | call <tool> [jsonArgs] | seq <file|->");
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
} finally {
  // Teardown: close the connect-page tab (dead weight after the relay ends);
  // optionally close every group tab (--close-tabs-all) for throwaway runs.
  try {
    const res = await request("tools/call", { name: "browser_tabs", arguments: { action: "list" } }, 8000);
    const text = resultText(res);
    const closable = [...text.matchAll(/^-\s*(\d+):.*\]\(([^)]*)\)/gm)]
      .filter(([, , url]) => /connect\.html/i.test(url))
      .map(([, idx]) => Number(idx));
    for (const idx of closable.reverse()) {
      try {
        await request("tools/call", { name: "browser_tabs", arguments: { action: "close", index: idx } }, 8000);
      } catch {
        // tab already gone
      }
    }
    if (CLOSE_ALL) {
      const again = resultText(await request("tools/call", { name: "browser_tabs", arguments: { action: "list" } }, 8000));
      for (const idx of [...again.matchAll(/^-\s*(\d+):/gm)].map(([, idx]) => Number(idx)).reverse()) {
        try {
          await request("tools/call", { name: "browser_tabs", arguments: { action: "close", index: idx } }, 8000);
        } catch {
          // already closed
        }
      }
      console.log("teardown: all group tabs closed");
    } else if (closable.length) {
      console.log(`teardown: closed ${closable.length} connect-page tab(s)`);
    }
  } catch {
    // teardown best-effort — the work above already happened; never mask it
  }
  try {
    child.kill();
  } catch {
    // already exited
  }
}
process.exit(exitCode);