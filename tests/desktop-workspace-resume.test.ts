import { existsSync, mkdtempSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  channelsInWorkspaceTab,
  normalizeWorkspaceTabGroups,
  pickResumeSession,
} from "../src/cli/commands/desktop.js";
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

  it("skips a session another channel already holds when picking a resume target", () => {
    const older = "code-a-202605251200";
    const newer = "code-a-202605251300";
    appendSessionMessage(older, { role: "user", content: "old" });
    appendSessionMessage(newer, { role: "user", content: "new" });
    patchSessionMeta(older, { workspace: "/proj/a" });
    patchSessionMeta(newer, { workspace: "/proj/a" });
    pinOldMtime(older, newer);
    const list = listSessionsForWorkspace("/proj/a");

    // Newest wins normally…
    expect(pickResumeSession(list)?.name).toBe(newer);
    // …but if another channel already holds it, fall through to the next free one.
    expect(pickResumeSession(list, (s) => s.name === newer)?.name).toBe(older);
    // Every candidate held → null, so the switch mints a fresh session.
    expect(pickResumeSession(list, () => true)).toBeNull();
  });

  it("ignores sessions that belong to a different workspace", () => {
    appendSessionMessage("code-b-202605251300", { role: "user", content: "b" });
    patchSessionMeta("code-b-202605251300", { workspace: "/proj/b" });

    expect(pickResumeSession(listSessionsForWorkspace("/proj/a"))).toBeNull();
  });
});

describe("normalizeWorkspaceTabGroups — one visual tab per workspace", () => {
  it("joins duplicate workspace channels into the first workspace group", () => {
    let next = 0;
    const normalized = normalizeWorkspaceTabGroups(
      [
        { dir: "/proj/a", groupId: "g7", session: "a-1" },
        { dir: "/proj/b", groupId: "g8", session: "b-1" },
        { dir: "/proj/a/", groupId: "legacy-duplicate", session: "a-2" },
      ],
      () => `new-${++next}`,
    );

    expect(normalized.map((entry) => entry.groupId)).toEqual(["g7", "g8", "g7"]);
    expect(normalized.map((entry) => entry.session)).toEqual(["a-1", "b-1", "a-2"]);
  });

  it("separates a corrupt group id reused by different workspaces", () => {
    let next = 0;
    const normalized = normalizeWorkspaceTabGroups(
      [
        { dir: "/proj/a", groupId: "g1" },
        { dir: "/proj/b", groupId: "g1" },
      ],
      () => `new-${++next}`,
    );

    expect(normalized[0]!.groupId).toBe("g1");
    expect(normalized[1]!.groupId).toBe("new-1");
  });
});

describe("channelsInWorkspaceTab — workspace tab owns all child agents", () => {
  const channel = (id: string, groupId: string, rootDir: string) => ({ id, groupId, rootDir });

  it("selects every session channel in the workspace tab", () => {
    const channels = [
      channel("t1", "g1", "/proj/a"),
      channel("t2", "g1", "/proj/a"),
      channel("t3", "g2", "/proj/b"),
    ];

    expect(channelsInWorkspaceTab(channels, channels[0]!).map((item) => item.id)).toEqual([
      "t1",
      "t2",
    ]);
  });

  it("does not capture an agent owned by another workspace tab", () => {
    const channels = [channel("t1", "g1", "/proj/a"), channel("t2", "g2", "/proj/b")];
    expect(channelsInWorkspaceTab(channels, channels[0]!)).toEqual([channels[0]]);
  });
});
