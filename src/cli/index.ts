// First import — reject unsupported Node versions before heavier startup
// paths can turn an engine mismatch into an opaque crash.
import "./node-version-guard.js";

// Then re-exec with a bigger V8 heap when Node's stock 2 GiB cap is in force
// (issue #1011). Side-effect on module load, before any heavy import below runs.
import "./heap-limit-launch.js";

// Wrap stdout/stderr before any third-party lib gets a chance to emit BEL on
// Windows cmd, which would beep the system bell every render (#1786).
import "./strip-bel.js";

import { Command } from "commander";
import { isReasoningEffort, loadProxyConfig, saveReasoningEffort } from "../config.js";
import { t } from "../i18n/index.js";
import { VERSION } from "../index.js";
import { installProxyIfConfigured } from "../net/proxy.js";
import { resolveDefaults } from "./resolve.js";
import { markPhase } from "./startup-profile.js";

// HTTPS_PROXY / HTTP_PROXY only reach Node's fetch via undici's global
// dispatcher; install before any client (DeepSeek, web tools) constructs a
// fetch closure (#646). Argv is peeked manually here — commander hasn't run
// yet — so position of `--no-proxy` doesn't matter and we can honor it before
// any fetch closure captures the dispatcher.
const cliNoProxy = process.argv.includes("--no-proxy");
const cfgProxy = loadProxyConfig();
installProxyIfConfigured(process.env, {
  disabled: cliNoProxy || cfgProxy.disabled === true,
  url: cfgProxy.url,
  extraNoProxy: cfgProxy.noProxy,
  bypassDeepSeekDirect: cfgProxy.bypassDeepSeekDirect,
});

markPhase("cli_module_loaded");

function persistEffortFlag(flag: unknown): void {
  if (typeof flag !== "string") return;
  const v = flag.toLowerCase();
  if (!isReasoningEffort(v)) return;
  try {
    saveReasoningEffort(v);
  } catch {
    /* best-effort */
  }
}

/** Lenient: malformed → undefined (no cap) so a bad flag doesn't abort launch. */
function parseBudgetFlag(raw: number | undefined): number | undefined {
  if (raw === undefined) return undefined;
  if (!Number.isFinite(raw) || raw <= 0) {
    process.stderr.write(
      `▲ ignoring --budget=${raw} (must be a positive number) — running with no cap\n`,
    );
    return undefined;
  }
  return raw;
}

const program = new Command();
program
  .name("reasonix")
  .description("Reasonix desktop backend (headless JSON-RPC over stdio)")
  .version(VERSION)
  .option("--no-proxy", t("ui.noProxyHint"));

// The desktop app is the only product surface. The Tauri shell spawns this
// entry as `reasonix desktop` and speaks JSON-RPC over stdio
// (desktop/src-tauri/src/rpc.rs).
program
  .command("desktop")
  .description("headless JSON-RPC chat for the desktop client (internal)")
  .option("-m, --model <id>", t("ui.modelIdHint"))
  .option("--dir <path>", "root directory for filesystem tools (default: cwd)")
  .option("--effort <level>", t("ui.effortHintShort"))
  .option("--budget <usd>", t("ui.budgetHintShort"), (v) => Number.parseFloat(v))
  .action(async (opts) => {
    persistEffortFlag(opts.effort);
    const defaults = resolveDefaults({
      model: opts.model,
      mcp: [],
      effort: opts.effort,
      noConfig: false,
    });
    markPhase("desktop_import_started");
    const { desktopCommand } = await import("./commands/desktop.js");
    markPhase("desktop_import_completed");
    await desktopCommand({
      model: defaults.model,
      budgetUsd: parseBudgetFlag(opts.budget),
      dir: opts.dir,
    });
  });

program.parseAsync(process.argv).catch((err) => {
  console.error(err);
  process.exit(1);
});
