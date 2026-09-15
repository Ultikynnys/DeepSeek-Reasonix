import { existsSync, mkdtempSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pickResumeSession } from "../src/cli/commands/desktop.js";
import {
  appendSessionMessage,
  listSessionsForWorkspace,
  patchSessionMeta,
  sessionPath,
} from "../src/memory/session.js";

describe("desktop workspace-switch session resume", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "reasonix-ws-resume-"));
    vi.stubEnv("USERPROFILE", tmp); // Windows
    vi.stubEnv("HOME", tmp); // Unix
    // os.homedir() is cached per-process on some platforms: override via spy.
    vi.spyOn(require("node:os"), "homedir").mockReturnValue(tmp);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  /** Pin mtimes low so recency comes from the name-embedded timestamp: keeps
   *  the newest-first ordering deterministic across machines and clocks. */
  function pinOldMtime(...names: string[]): void {
    const old = new Date("2020-01-01T00:00:00Z");
    for (const name of names) utimesSync(sessionPath(name), old, old);
  }

  it("yields null for a workspace with no sessions (a switch mints fresh)", () => {
    expect(pickResumeSession([])).toBeNull();
    expect(pickResumeSession(listSessionsForWorkspace("/proj/empty"))).toBeNull();
  });

  it("resumes the workspace's most recent session", () => {
    const older = "code-a-202605251200";
    const newer = "code-a-202605251300";
    appendSessionMessage(older, { role: "user", content: "old" });
    appendSessionMessage(newer, { role: "user", content: "new" });
    patchSessionMeta(older, { workspace: "/proj/a" });
    patchSessionMeta(newer, { workspace: "/proj/a" });
    pinOldMtime(older, newer);

    expect(pickResumeSession(listSessionsForWorkspace("/proj/a"))?.name).toBe(newer);
  });

  it("resumes the latest session even when an older session has more messages", () => {
    const older = "code-a-202605251200";
    const newer = "code-a-202605251300";
    appendSessionMessage(older, { role: "user", content: "one" });
    appendSessionMessage(older, { role: "assistant", content: "two" });
    appendSessionMessage(older, { role: "user", content: "three" });
    appendSessionMessage(newer, { role: "user", content: "only" });
    patchSessionMeta(older, { workspace: "/proj/a" });
    patchSessionMeta(newer, { workspace: "/proj/a" });
    pinOldMtime(older, newer);

    expect(pickResumeSession(listSessionsForWorkspace("/proj/a"))?.name).toBe(newer);
  });

  it("ignores sessions that belong to a different workspace", () => {
    appendSessionMessage("code-b-202605251300", { role: "user", content: "b" });
    patchSessionMeta("code-b-202605251300", { workspace: "/proj/b" });

    expect(pickResumeSession(listSessionsForWorkspace("/proj/a"))).toBeNull();
  });
});
