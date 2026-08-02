import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  collectMemoryEntriesForWorkspace,
  deleteMemoryEntry,
  exportMemories,
  importMemories,
  readMemoryEntryDetail,
  writeMemoryEntry,
} from "../src/desktop/memory-browser.js";
import { MemoryStore } from "../src/memory/user.js";

describe("desktop memory browser", () => {
  let root: string;
  let reasonixHome: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "reasonix-memory-project-"));
    reasonixHome = join(mkdtempSync(join(tmpdir(), "reasonix-memory-home-")), ".reasonix");
    mkdirSync(reasonixHome, { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(reasonixHome, { recursive: true, force: true });
  });

  it("lists project REASONIX.md, global REASONIX.md, and structured memory entries", () => {
    writeFileSync(join(root, "REASONIX.md"), "project note", "utf8");
    writeFileSync(join(reasonixHome, "REASONIX.md"), "global note", "utf8");
    const store = new MemoryStore({ homeDir: reasonixHome, projectRoot: root });
    store.write({
      name: "cli_pref",
      scope: "global",
      type: "user",
      description: "Use concise CLI output",
      body: "Keep command output short.",
    });
    store.write({
      name: "build_cmd",
      scope: "project",
      type: "project",
      description: "Use npm run verify",
      body: "Run npm run verify before release.",
    });

    const entries = collectMemoryEntriesForWorkspace(root, { reasonixHome });

    expect(entries.map((e) => `${e.kind}:${e.scope}:${e.name}`)).toEqual([
      "project_file:project:REASONIX.md",
      "global_file:global:REASONIX.md",
      "structured:global:cli_pref",
      "structured:project:build_cmd",
    ]);
    expect(entries.every((e) => existsSync(e.path))).toBe(true);
    expect(entries.find((e) => e.name === "cli_pref")!.type).toBe("user");
  });

  it("reads details only for listed memory files", () => {
    writeFileSync(join(root, "REASONIX.md"), "project note", "utf8");
    const entries = collectMemoryEntriesForWorkspace(root, { reasonixHome });

    const detail = readMemoryEntryDetail({ path: entries[0]!.path }, root, { reasonixHome });

    expect(detail).toMatchObject({
      kind: "project_file",
      scope: "project",
      name: "REASONIX.md",
      body: "project note",
    });
    expect(() =>
      readMemoryEntryDetail({ path: join(reasonixHome, "not-listed.md") }, root, {
        reasonixHome,
      }),
    ).toThrow(/not available/);
  });

  it("writeMemoryEntry creates a structured entry + regenerates MEMORY.md", () => {
    const { path } = writeMemoryEntry(
      {
        scope: "project",
        name: "verify-first",
        description: "Run the verify suite",
        body: "Always run npm run verify before committing.",
        type: "feedback",
        priority: "high",
      },
      root,
      { reasonixHome },
    );
    expect(existsSync(path)).toBe(true);

    const store = new MemoryStore({ homeDir: reasonixHome, projectRoot: root });
    const entry = store.read("project", "verify-first");
    expect(entry.type).toBe("feedback");
    expect(entry.priority).toBe("high");
    expect(entry.body).toContain("npm run verify");
    // Index regenerated so the next /new pins it.
    expect(store.loadIndex("project")?.content).toContain("verify-first");
  });

  it("writeMemoryEntry defaults type by scope and rejects empty bodies", () => {
    const { path } = writeMemoryEntry(
      { scope: "global", name: "default-type", description: "d", body: "x" },
      root,
      { reasonixHome },
    );
    const store = new MemoryStore({ homeDir: reasonixHome, projectRoot: root });
    expect(store.read("global", "default-type").type).toBe("user");
    expect(() =>
      writeMemoryEntry({ scope: "global", name: "empty", description: "d", body: "" }, root, {
        reasonixHome,
      }),
    ).toThrow(/body/);
  });

  it("deleteMemoryEntry removes a structured entry by browser path", () => {
    writeMemoryEntry({ scope: "global", name: "stale", description: "d", body: "old" }, root, {
      reasonixHome,
    });
    const entries = collectMemoryEntriesForWorkspace(root, { reasonixHome });
    const target = entries.find((e) => e.name === "stale")!;
    expect(deleteMemoryEntry(target.path, root, { reasonixHome })).toBe(true);
    const store = new MemoryStore({ homeDir: reasonixHome, projectRoot: root });
    expect(() => store.read("global", "stale")).toThrow();
    expect(store.loadIndex("global")).toBeNull();
    expect(deleteMemoryEntry(target.path, root, { reasonixHome })).toBe(false);
  });

  it("deleteMemoryEntry removes freeform project files too", () => {
    writeFileSync(join(root, "REASONIX.md"), "note", "utf8");
    const entries = collectMemoryEntriesForWorkspace(root, { reasonixHome });
    const projectFile = entries.find((e) => e.kind === "project_file")!;
    expect(deleteMemoryEntry(projectFile.path, root, { reasonixHome })).toBe(true);
    expect(existsSync(join(root, "REASONIX.md"))).toBe(false);
  });

  it("exportMemories returns a bundle of structured entries", () => {
    writeMemoryEntry(
      { scope: "project", name: "rule-a", description: "A", body: "body a", priority: "high" },
      root,
      { reasonixHome },
    );
    writeMemoryEntry({ scope: "global", name: "rule-b", description: "B", body: "body b" }, root, {
      reasonixHome,
    });
    const bundle = exportMemories(root, { reasonixHome });
    expect(bundle.format).toBe("reasonix-memory");
    expect(bundle.entries.map((e) => e.name).sort()).toEqual(["rule-a", "rule-b"]);
    const ruleA = bundle.entries.find((e) => e.name === "rule-a")!;
    expect(ruleA.scope).toBe("project");
    expect(ruleA.priority).toBe("high");
    // Freeform files are not part of the bundle.
    expect(bundle.entries.some((e) => e.kind === "project_file")).toBe(false);
  });

  it("importMemories replays a bundle into the current project", () => {
    writeFileSync(join(root, "REASONIX.md"), "note", "utf8");
    const bundle = {
      format: "reasonix-memory",
      version: 1,
      entries: [
        {
          name: "imported-rule",
          scope: "project",
          type: "feedback",
          description: "Imported",
          body: "Do the thing.",
          priority: "high",
        },
        { name: "bad name!", scope: "global", description: "x", body: "y" },
      ],
    };
    const result = importMemories(bundle, root, { reasonixHome });
    expect(result.imported).toBe(1);
    expect(result.skipped).toEqual(["bad name!"]);
    const store = new MemoryStore({ homeDir: reasonixHome, projectRoot: root });
    expect(store.read("project", "imported-rule").priority).toBe("high");
  });

  it("importMemories rejects non-bundle payloads", () => {
    expect(() => importMemories({ nope: true }, root, { reasonixHome })).toThrow(/reasonix-memory/);
  });
});
