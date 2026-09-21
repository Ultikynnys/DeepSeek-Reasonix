import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sessionRecency } from "@reasonix/core-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ensureSessionDir,
  listSessionsForWorkspace,
  listSessionsForWorkspaceAsync,
  patchSessionMeta,
  patchSessionWorkspaceIfMissing,
  sessionDir,
  sessionExists,
  sessionPath,
} from "../src/memory/session.js";

describe("desktop empty session persistence and workspace visibility", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "reasonix-empty-session-"));
    vi.stubEnv("USERPROFILE", tmp);
    vi.stubEnv("HOME", tmp);
    vi.spyOn(require("node:os"), "homedir").mockReturnValue(tmp);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  it("eagerly materializes an empty session folder and transcript on disk", () => {
    const name = "desktop-20260905120000-1";
    ensureSessionDir(name);
    patchSessionMeta(name, { workspace: "/test/workspace" });

    expect(sessionExists(name)).toBe(true);
    expect(existsSync(sessionDir(name))).toBe(true);
    expect(existsSync(sessionPath(name))).toBe(true);
  });

  it("lists an empty session in listSessionsForWorkspaceAsync", async () => {
    const name = "desktop-20260905120000-1";
    ensureSessionDir(name);
    patchSessionMeta(name, { workspace: "/test/workspace" });

    const result = await listSessionsForWorkspaceAsync("/test/workspace").value;
    expect(result.some((s) => s.name === name)).toBe(true);
    const session = result.find((s) => s.name === name);
    expect(session?.messageCount).toBe(0);
  });

  it("lists an empty session folder even if messages.jsonl is not yet created", async () => {
    const name = "desktop-20260905130000-1";
    const dir = sessionDir(name);
    mkdirSync(dir, { recursive: true });
    patchSessionMeta(name, { workspace: "/test/workspace" });

    const result = await listSessionsForWorkspaceAsync("/test/workspace").value;
    expect(result.some((s) => s.name === name)).toBe(true);
    const session = result.find((s) => s.name === name);
    expect(session?.messageCount).toBe(0);
  });

  it("patchSessionWorkspaceIfMissing backfills workspace so empty session appears in workspace", async () => {
    const name = "code-workspace-20260905140000-1";
    ensureSessionDir(name);
    // Initially minted without workspace meta
    patchSessionMeta(name, { summary: "New Chat" });

    // bootstrapTab calls patchSessionWorkspaceIfMissing
    expect(patchSessionWorkspaceIfMissing(name, "/test/workspace")).toBe(true);

    const after = await listSessionsForWorkspaceAsync("/test/workspace").value;
    expect(after.some((s) => s.name === name)).toBe(true);
  });

  it("sessionRecency honors updatedAt on SessionInfo", () => {
    const timestamp = Date.UTC(2026, 8, 5, 12, 0, 0);
    const recencyWithLastActive = sessionRecency({
      name: "custom",
      mtime: 1000,
      lastActive: timestamp,
    });
    const recencyWithUpdatedAt = sessionRecency({
      name: "custom",
      mtime: 1000,
      updatedAt: timestamp,
    });
    expect(recencyWithLastActive).toBe(timestamp);
    expect(recencyWithUpdatedAt).toBe(timestamp);
  });
});
