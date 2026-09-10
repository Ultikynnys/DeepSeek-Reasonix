import { loadEffectiveMcpConfig } from "../../config.js";
import { formatMcpLifecycleEvent } from "../../desktop/mcp-lifecycle.js";
import type { McpLifecycleEvent } from "../../desktop/mcp-lifecycle.js";
import { formatMcpSlowToast } from "../../desktop/mcp-toast.js";
import { t } from "../../i18n/index.js";
import type { CacheFirstLoop } from "../../loop.js";
import { McpClient } from "../../mcp/client.js";
import { type InspectionReport, inspectMcpServer } from "../../mcp/inspect.js";
import {
  ensurePlaywrightTooling,
  isPlaywrightSpec,
  playwrightDescriptionSuffix,
  playwrightToolingNotice,
} from "../../mcp/playwright-tooling.js";
import { preflightStdioSpec } from "../../mcp/preflight.js";
import { type McpClientHost, bridgeMcpTools, registerSingleMcpTool } from "../../mcp/registry.js";
import type { McpServerSpec } from "../../mcp/spec.js";
import { overlayMatchedSpec, parseMcpSpec, specToRaw } from "../../mcp/spec.js";
import { buildMcpServerSummary } from "../../mcp/summary.js";
import type { McpServerSummary } from "../../mcp/summary.js";
import { buildTransportFromSpec } from "../../mcp/transport-from-spec.js";
import type { ToolRegistry } from "../../tools.js";
import type { ToolSpec } from "../../types.js";

export interface ProgressInfo {
  toolName: string;
  progress: number;
  total?: number;
  message?: string;
}

interface SpecRecord {
  spec: string;
  client: McpClient;
  summary: McpServerSummary;
  /** Names of bridged tools — used for hot-unbridge. */
  registeredNames: string[];
  /** ToolSpec snapshots captured AFTER bridge — handed to loop.prefix.addTool on hot-add. */
  registeredSpecs: ToolSpec[];
  /** Bare MCP tool names currently filtered out of the registry (user toggles).
   *  Diffs against config to decide which tools to un/register without respawn. */
  disabledTools: string[];
}

export interface RuntimeContext {
  getTools: () => ToolRegistry | undefined;
  getMcpPrefix: () => string | undefined;
  getRequestedCount: () => number;
  getWorkspaceDir?: () => string | undefined;
  progressSink: { current: ((info: ProgressInfo) => void) | null };
}

export type McpLifecycleSink = (event: McpLifecycleEvent) => void;

export const stderrLifecycleSink: McpLifecycleSink = (ev) => {
  if (ev.state === "slow") {
    process.stderr.write(
      `${formatMcpSlowToast({ name: ev.serverName, p95Ms: ev.p95Ms, sampleSize: ev.sampleSize })}\n`,
    );
    return;
  }
  if (ev.state === "failed") {
    process.stderr.write(
      `${formatMcpLifecycleEvent(ev)}\n  → ${t("mcpLifecycle.failedSetupHint")}\n`,
    );
    return;
  }
  process.stderr.write(`${formatMcpLifecycleEvent(ev)}\n`);
};

export interface McpFailure {
  spec: string;
  name: string;
  reason: string;
  at: number;
}

export interface McpRuntime {
  size(): number;
  specs(): string[];
  summaries(): McpServerSummary[];
  /** Last bridge failure per spec — drives the "not bridged" reason shown in the dashboard. */
  failures(): McpFailure[];
  /** Per-spec bare tool names currently registered (enabled) vs filtered out (disabled) —
   *  drives the per-tool toggle UI and its current state. */
  toolFilterState(): Array<{ spec: string; enabled: string[]; disabled: string[] }>;
  addSpec(
    raw: string,
    loop?: CacheFirstLoop,
    signal?: AbortSignal,
  ): Promise<{ ok: true; summary: McpServerSummary } | { ok: false; reason: string }>;
  removeSpec(raw: string, loop?: CacheFirstLoop): Promise<boolean>;
  reloadFromConfig(loop?: CacheFirstLoop): Promise<{
    added: string[];
    removed: string[];
    failed: Array<{ spec: string; reason: string }>;
    summaries: McpServerSummary[];
  }>;
  closeAll(): Promise<void>;
  /** Replace the sink that lifecycle events flow through — App.tsx swaps this in on mount so toasts land in the alt-screen UI instead of corrupting it via stderr. */
  setLifecycleSink(sink: McpLifecycleSink): void;
}

export function createMcpRuntime(ctx: RuntimeContext): McpRuntime {
  const records = new Map<string, SpecRecord>();
  const insertionOrder: string[] = [];
  const failureMap = new Map<string, McpFailure>();
  let sink: McpLifecycleSink = stderrLifecycleSink;

  async function addSpec(
    raw: string,
    loop?: CacheFirstLoop,
    signal?: AbortSignal,
  ): Promise<{ ok: true; summary: McpServerSummary } | { ok: false; reason: string }> {
    if (records.has(raw)) {
      return { ok: true, summary: records.get(raw)!.summary };
    }
    failureMap.delete(raw);
    const tools = ctx.getTools();
    if (!tools) return { ok: false, reason: "no tool registry available" };
    const normalized = loadEffectiveMcpConfig(ctx.getWorkspaceDir?.());
    let label = "anon";
    let mcp: McpClient | undefined;
    // Per-server readiness gate — tool dispatches via the bridge await
    // this before calling into `live.callTool`. Resolved on `connected`,
    // rejected on `failed`, so a tool invoked mid-handshake waits
    // (capped by `bridgeMcpTools`'s `readyTimeoutMs`) instead of
    // surfacing a transport error.
    let resolveReady!: () => void;
    let rejectReady!: (err: Error) => void;
    const ready = new Promise<void>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    // Avoid unhandledRejection if no consumer awaits `ready` yet.
    ready.catch(() => undefined);
    try {
      const parsed = parseMcpSpec(raw);
      label = parsed.name ?? "anon";
      const matched = parsed.name ? normalized.find((s) => s.name === parsed.name) : undefined;
      const spec = overlayMatchedSpec(parsed, matched);
      if (spec.disabled) {
        sink({ state: "disabled", name: label });
        rejectReady(new Error(`MCP server "${label}" is disabled`));
        failureMap.set(raw, { spec: raw, name: label, reason: "disabled by user", at: Date.now() });
        return { ok: false, reason: "disabled by user" };
      }
      sink({ state: "handshake", name: label });
      const t0 = Date.now();
      const namePrefix = spec.name
        ? `${spec.name}_`
        : ctx.getRequestedCount() === 1 && ctx.getMcpPrefix()
          ? (ctx.getMcpPrefix() as string)
          : "";
      if (spec.transport === "stdio") preflightStdioSpec(spec);
      const workspaceDir = ctx.getWorkspaceDir?.();
      // Hardcoded playwright tooling contract: guarantee the durable driver +
      // AGENTS.md pair exists (create/upgrade as needed) before any agent
      // touches the browser, and surface the maintenance duty to the agent
      // via the bridge's first-call notice + description pointers.
      const playwrightTooling = isPlaywrightSpec(spec) ? ensurePlaywrightTooling() : undefined;
      const transport = buildTransportFromSpec(spec, { cwd: workspaceDir });
      mcp = new McpClient({ transport, workspaceDir });
      await mcp.initialize({ signal });
      const host: McpClientHost = { client: mcp };
      const bridge = await bridgeMcpTools(mcp, {
        registry: tools,
        namePrefix,
        serverName: label,
        host,
        ready,
        disabledTools: spec.disabledTools ? new Set(spec.disabledTools) : undefined,
        ...(playwrightTooling
          ? {
              toolingNotice: playwrightToolingNotice(playwrightTooling),
              descriptionSuffix: playwrightDescriptionSuffix(playwrightTooling),
            }
          : {}),
        onProgress: (info) => ctx.progressSink.current?.(info),
        onSlow: (info) =>
          sink({
            state: "slow",
            serverName: info.serverName,
            p95Ms: info.p95Ms,
            sampleSize: info.sampleSize,
          }),
      });
      // Tools are registered — record the bridge NOW so the UI shows
      // "bridged" even if later non-critical steps (inspect, hot-add) fail.
      const ms = Date.now() - t0;
      const allSpecs = tools.specs();
      const registeredSpecs = allSpecs.filter((s) =>
        bridge.registeredNames.includes(s.function.name),
      );
      // Create a provisional record immediately (tools already usable).
      records.set(raw, {
        spec: raw,
        client: mcp,
        summary: buildMcpServerSummary({
          label,
          spec: raw,
          toolCount: bridge.registeredNames.length,
          report: {
            protocolVersion: mcp.protocolVersion,
            serverInfo: mcp.serverInfo,
            capabilities: mcp.serverCapabilities ?? {},
            tools: { supported: true, items: [] },
            resources: { supported: false, reason: "still inspecting" },
            prompts: { supported: false, reason: "still inspecting" },
            elapsedMs: ms,
          },
          host,
          bridgeEnv: bridge.env,
        }),
        registeredNames: bridge.registeredNames,
        registeredSpecs,
        disabledTools: spec.disabledTools ?? [],
      });
      insertionOrder.push(raw);
      resolveReady();
      sink({
        state: "tools-ready",
        name: label,
        tools: bridge.registeredNames.length,
        ms,
      });

      // Non-critical: inspect + hot-add. Failures here don't un-bridge.
      let report: InspectionReport;
      try {
        report = await inspectMcpServer(mcp);
      } catch {
        report = {
          protocolVersion: mcp.protocolVersion,
          serverInfo: mcp.serverInfo,
          capabilities: mcp.serverCapabilities ?? {},
          tools: { supported: true, items: [] },
          resources: { supported: false, reason: "inspect failed" },
          prompts: { supported: false, reason: "inspect failed" },
          elapsedMs: 0,
        };
      }
      const resourceCount = report.resources.supported ? report.resources.items.length : 0;
      const promptCount = report.prompts.supported ? report.prompts.items.length : 0;
      // Re-emit with full inspection data (the provisional event reported 0).
      sink({
        state: "connected",
        name: label,
        tools: bridge.registeredNames.length,
        resources: resourceCount,
        prompts: promptCount,
        ms,
      });
      const summary = buildMcpServerSummary({
        label,
        spec: raw,
        toolCount: bridge.registeredNames.length,
        report,
        host,
        bridgeEnv: bridge.env,
      });
      // Replace the provisional record with the fully-inspected summary.
      records.set(raw, {
        spec: raw,
        client: mcp,
        summary,
        registeredNames: bridge.registeredNames,
        registeredSpecs,
        disabledTools: spec.disabledTools ?? [],
      });
      // Hot-add: shift the prefix so the live loop sees the new tools
      // on the very next turn. Each addTool is one cache-miss turn.
      if (loop)
        for (const s of registeredSpecs)
          try {
            loop.prefix.addTool(s);
          } catch (err) {
            sink({
              state: "warn",
              name: label,
              reason: `addTool failed for ${s.function.name}: ${(err as Error).message}`,
            });
          }
      return { ok: true, summary };
    } catch (err) {
      // If we got far enough to create a provisional record, keep it —
      // tools are already registered and usable even after a late failure.
      const reason = (err as Error).message;
      if (!records.has(raw)) {
        await mcp?.close().catch(() => undefined);
        rejectReady(new Error(`MCP server "${label}" failed to start: ${reason}`));
        sink({ state: "failed", name: label, reason });
        failureMap.set(raw, { spec: raw, name: label, reason, at: Date.now() });
        return { ok: false, reason };
      }
      sink({ state: "warn", name: label, reason });
      return { ok: true, summary: records.get(raw)!.summary };
    }
  }

  async function removeSpec(raw: string, loop?: CacheFirstLoop): Promise<boolean> {
    failureMap.delete(raw);
    const record = records.get(raw);
    if (!record) return false;
    await record.client.close().catch(() => undefined);
    const tools = ctx.getTools();
    for (const name of record.registeredNames) {
      tools?.unregister(name);
      loop?.prefix.removeTool(name);
    }
    records.delete(raw);
    const idx = insertionOrder.indexOf(raw);
    if (idx >= 0) insertionOrder.splice(idx, 1);
    return true;
  }

  /** Registered name → bare config name — strips the `server_` namespace prefix. */
  function mcpBareToolName(prefix: string): (registeredName: string) => string {
    return (registeredName) =>
      prefix && registeredName.startsWith(prefix)
        ? registeredName.slice(prefix.length)
        : registeredName;
  }

  /** Apply a new per-tool disable set to a LIVE server record — unregister
   *  newly-disabled tools and re-register newly-enabled ones from the live
   *  server listing, without closing/reopening the server process. */
  async function applyToolDisableSet(
    raw: string,
    loop: CacheFirstLoop | undefined,
    nextDisabled: ReadonlySet<string>,
  ): Promise<void> {
    const record = records.get(raw);
    if (!record) return;
    const env = record.summary.bridgeEnv;
    const bareOf = mcpBareToolName(env.prefix);

    // 1. Disable — unregister tools that entered the disable set.
    const stillEnabled: string[] = [];
    const stillEnabledSpecs: ToolSpec[] = [];
    for (let i = 0; i < record.registeredNames.length; i++) {
      const name = record.registeredNames[i]!;
      if (nextDisabled.has(bareOf(name))) {
        env.registry.unregister(name);
        loop?.prefix.removeTool(name);
        continue;
      }
      stillEnabled.push(name);
      const specSnapshot = record.registeredSpecs.find((s) => s.function.name === name);
      if (specSnapshot) stillEnabledSpecs.push(specSnapshot);
    }
    record.registeredNames = stillEnabled;
    record.registeredSpecs = stillEnabledSpecs;

    // 2. Enable — re-register tools that left the disable set, from the live listing.
    const toEnable = record.disabledTools.filter((bare) => !nextDisabled.has(bare));
    if (toEnable.length > 0) {
      const listed = await env.host.client.listTools();
      const byName = new Map(listed.tools.map((t) => [t.name, t]));
      for (const bare of toEnable) {
        const mcpTool = byName.get(bare);
        if (!mcpTool) continue; // server no longer exposes it — nothing to register
        const registeredName = registerSingleMcpTool(mcpTool, env);
        if (!registeredName) continue;
        record.registeredNames.push(registeredName);
        const specSnapshot = env.registry.specs().find((s) => s.function.name === registeredName);
        if (specSnapshot) {
          record.registeredSpecs.push(specSnapshot);
          if (loop)
            try {
              loop.prefix.addTool(specSnapshot);
            } catch (err) {
              sink({
                state: "warn",
                name: record.summary.label,
                reason: `addTool failed for ${registeredName}: ${(err as Error).message}`,
              });
            }
        }
      }
    }

    record.disabledTools = [...nextDisabled];
    sink({
      state: "tools-ready",
      name: record.summary.label,
      tools: record.registeredNames.length,
      ms: 0,
    });
  }

  async function reloadFromConfig(loop?: CacheFirstLoop): Promise<{
    added: string[];
    removed: string[];
    failed: Array<{ spec: string; reason: string }>;
    summaries: McpServerSummary[];
  }> {
    const normalized = loadEffectiveMcpConfig(ctx.getWorkspaceDir?.());
    const desiredMap = new Map<string, McpServerSpec>();
    const desired: string[] = [];
    for (const spec of normalized) {
      const raw = specToRaw(spec);
      desiredMap.set(raw, spec);
      desired.push(raw);
    }
    const desiredSet = new Set(desired);
    const currentSet = new Set(records.keys());
    const added: string[] = [];
    const removed: string[] = [];
    const failed: Array<{ spec: string; reason: string }> = [];

    for (const spec of [...currentSet]) {
      const next = desiredMap.get(spec);
      if (!next) {
        // Removed from config entirely.
        await removeSpec(spec, loop);
        removed.push(spec);
        continue;
      }
      if (next.disabled) {
        // Config-disabled while live — stop it; still configured, so not "removed".
        const label = records.get(spec)?.summary.label ?? "?";
        await removeSpec(spec, loop);
        failureMap.set(spec, {
          spec,
          name: label,
          reason: "disabled by user",
          at: Date.now(),
        });
        continue;
      }
      // Per-tool disable delta — hot un/register without respawning.
      const nextTools = new Set(next.disabledTools ?? []);
      const cur = new Set(records.get(spec)?.disabledTools ?? []);
      const changed = nextTools.size !== cur.size || [...nextTools].some((t) => !cur.has(t));
      if (changed) {
        try {
          await applyToolDisableSet(spec, loop, nextTools);
        } catch (err) {
          failed.push({ spec, reason: `tool filter update failed: ${(err as Error).message}` });
        }
      }
    }
    for (const spec of desired) {
      if (currentSet.has(spec)) continue;
      const result = await addSpec(spec, loop);
      if (result.ok) added.push(spec);
      else failed.push({ spec, reason: result.reason });
    }
    return { added, removed, failed, summaries: summaries() };
  }

  function specs(): string[] {
    return [...insertionOrder];
  }
  function summaries(): McpServerSummary[] {
    return insertionOrder
      .map((s) => records.get(s)?.summary)
      .filter((s): s is McpServerSummary => Boolean(s));
  }
  async function closeAll(): Promise<void> {
    for (const r of records.values()) await r.client.close().catch(() => undefined);
    records.clear();
    insertionOrder.length = 0;
    failureMap.clear();
  }
  function failures(): McpFailure[] {
    return [...failureMap.values()];
  }
  function toolFilterState(): Array<{ spec: string; enabled: string[]; disabled: string[] }> {
    return insertionOrder
      .map((raw) => {
        const rec = records.get(raw);
        if (!rec) return undefined;
        const bare = mcpBareToolName(rec.summary.bridgeEnv.prefix);
        return {
          spec: raw,
          enabled: rec.registeredNames.map(bare),
          disabled: [...rec.disabledTools],
        };
      })
      .filter((s): s is { spec: string; enabled: string[]; disabled: string[] } => Boolean(s));
  }
  function setLifecycleSink(s: McpLifecycleSink): void {
    sink = s;
  }
  return {
    size: () => records.size,
    specs,
    summaries,
    failures,
    toolFilterState,
    addSpec,
    removeSpec,
    reloadFromConfig,
    closeAll,
    setLifecycleSink,
  };
}
