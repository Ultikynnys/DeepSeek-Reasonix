/** Daemon-scoped singleton MCP clients for browser-bearing servers: one live
 *  client is one browser, so every tab sharing a spec attaches to the same one. */

import { McpClient } from "./client.js";
import type { McpClientHost } from "./registry.js";
import { type McpServerSpec, getMcpServerEnv, getMcpServerHeaders } from "./spec.js";
import { buildTransportFromSpec } from "./transport-from-spec.js";

export interface SharedClientEntry {
  key: string;
  client: McpClient;
  host: McpClientHost;
  /** Number of tab runtimes currently bridging this client. */
  refCount: number;
}

export interface SharedClientAcquireOptions {
  workspaceDir?: string;
  signal?: AbortSignal;
}

function stableRecord(rec?: Record<string, string>): Array<[string, string]> | null {
  return rec
    ? Object.keys(rec)
        .sort()
        .map((k) => [k, rec[k]!])
    : null;
}

function specIdentity(spec: McpServerSpec): string {
  if (spec.transport === "stdio") return JSON.stringify(["stdio", spec.command, spec.args]);
  return JSON.stringify([spec.transport, spec.url]);
}

/** Same workspace + connection args + env/headers resolve to one shared browser. */
export function sharedClientKey(spec: McpServerSpec, workspaceDir?: string): string {
  return JSON.stringify([
    workspaceDir ?? "",
    specIdentity(spec),
    stableRecord(getMcpServerEnv(spec)),
    stableRecord(getMcpServerHeaders(spec)),
  ]);
}

export class SharedClientRegistry {
  private readonly entries = new Map<string, SharedClientEntry>();
  private readonly inflight = new Map<string, Promise<SharedClientEntry>>();

  async acquire(
    spec: McpServerSpec,
    opts: SharedClientAcquireOptions = {},
  ): Promise<SharedClientEntry> {
    const key = sharedClientKey(spec, opts.workspaceDir);
    const live = this.entries.get(key);
    if (live) {
      live.refCount += 1;
      return live;
    }
    const pending = this.inflight.get(key);
    if (pending) {
      const entry = await pending;
      entry.refCount += 1;
      return entry;
    }
    const spawn = this.spawn(key, spec, opts);
    this.inflight.set(key, spawn);
    try {
      const entry = await spawn;
      this.entries.set(key, entry);
      entry.refCount += 1;
      return entry;
    } finally {
      this.inflight.delete(key);
    }
  }

  /** Drop one bridging tab; closes the client once no tab references it. */
  async release(key: string): Promise<void> {
    const entry = this.entries.get(key);
    if (!entry) return;
    entry.refCount -= 1;
    if (entry.refCount > 0) return;
    this.entries.delete(key);
    await entry.client.close().catch(() => undefined);
  }

  /** Close every shared client and forget all state. */
  async closeAll(): Promise<void> {
    const entries = [...this.entries.values()];
    this.entries.clear();
    this.inflight.clear();
    for (const entry of entries) await entry.client.close().catch(() => undefined);
  }

  private async spawn(
    key: string,
    spec: McpServerSpec,
    opts: SharedClientAcquireOptions,
  ): Promise<SharedClientEntry> {
    const transport = buildTransportFromSpec(spec, { cwd: opts.workspaceDir });
    const client = new McpClient({ transport, workspaceDir: opts.workspaceDir });
    try {
      await client.initialize({ signal: opts.signal });
    } catch (err) {
      await client.close().catch(() => undefined);
      throw err;
    }
    return { key, client, host: { client }, refCount: 0 };
  }
}
