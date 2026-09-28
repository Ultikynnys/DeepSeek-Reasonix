import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DeepSeekClient } from "../src/client.js";
import { CacheFirstLoop } from "../src/loop.js";
import { ImmutablePrefix } from "../src/memory/runtime.js";
import { loadSessionMeta, patchSessionMeta } from "../src/memory/session.js";

/** Regression harness for the post-model-switch vanishing-cards bug: turn
 *  ordinals must be monotonic across runtime rebuilds, even when the live log
 *  was compacted down to almost no user records. */

function okFetch(): typeof fetch {
  return vi.fn(
    async () =>
      new Response(
        JSON.stringify({
          choices: [
            { index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
  ) as unknown as typeof fetch;
}

describe("monotonic turn ordinals across runtime rebuilds", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "reasonix-turn-floor-"));
    vi.stubEnv("USERPROFILE", tmp);
    vi.stubEnv("HOME", tmp);
    vi.spyOn(require("node:os"), "homedir").mockReturnValue(tmp);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  it("floors the resume baseline on session-meta lastTurn after a compaction-shaped log", async () => {
    const sessionName = "turn-floor-compacted";
    const metaPath = join(tmp, ".reasonix", "sessions", sessionName, "meta.json");

    // Post-compaction log: hundreds of user records folded away, baseline
    // counting would resume at 2 — the exact regression that reissued ordinals.
    mkdirSync(join(metaPath, ".."), { recursive: true });
    writeFileSync(metaPath, JSON.stringify({ lastTurn: 4095 }), "utf8");
    expect(loadSessionMeta(sessionName).lastTurn).toBe(4095);

    const loop = new CacheFirstLoop({
      client: new DeepSeekClient({ apiKey: "sk-test", fetch: okFetch() }),
      prefix: new ImmutablePrefix({ system: "s" }),
      stream: false,
      session: sessionName,
    });
    loop.log.append({ role: "user", content: "kept summary tail 1" });
    loop.log.append({ role: "assistant", content: "kept reply 1" });
    loop.log.append({ role: "user", content: "kept summary tail 2" });
    // Re-resume like a runtime rebuild would: reload from the log.
    // (The constructor already resumed; floor via a second loop instance.)
    const rebuilt = new CacheFirstLoop({
      client: new DeepSeekClient({ apiKey: "sk-test", fetch: okFetch() }),
      prefix: new ImmutablePrefix({ system: "s" }),
      stream: false,
      session: sessionName,
    });
    rebuilt.log.append({ role: "user", content: "kept summary tail 1" });
    rebuilt.log.append({ role: "assistant", content: "kept reply 1" });
    rebuilt.log.append({ role: "user", content: "kept summary tail 2" });

    for await (const _ev of rebuilt.step("new turn after switch")) {
      break;
    }

    expect(rebuilt.currentTurn).toBeGreaterThan(4095);
  });

  it("turnFloor covers rebuilds within one process lifetime", () => {
    const loop = new CacheFirstLoop({
      client: new DeepSeekClient({ apiKey: "sk-test", fetch: okFetch() }),
      prefix: new ImmutablePrefix({ system: "s" }),
      stream: false,
      turnFloor: 77,
    });
    expect(loop.currentTurn).toBe(77);
  });

  it("persists lastTurn at turn start so a mid-turn crash can't reissue the ordinal", async () => {
    const sessionName = "turn-floor-persist";
    const loop = new CacheFirstLoop({
      client: new DeepSeekClient({ apiKey: "sk-test", fetch: okFetch() }),
      prefix: new ImmutablePrefix({ system: "s" }),
      stream: false,
      session: sessionName,
    });

    for await (const _ev of loop.step("first real turn")) {
      break;
    }

    expect(loadSessionMeta(sessionName).lastTurn).toBe(1);
    expect(loop.currentTurn).toBe(1);

    // A later rebuild floors on the persisted stamp even with an empty log.
    const rebuilt = new CacheFirstLoop({
      client: new DeepSeekClient({ apiKey: "sk-test", fetch: okFetch() }),
      prefix: new ImmutablePrefix({ system: "s" }),
      stream: false,
      session: sessionName,
    });
    expect(rebuilt.currentTurn).toBe(1);
  });

  it("patchSessionMeta preserves a concurrent lastTurn (never regresses the stamp)", () => {
    const sessionName = "turn-floor-patch-order";
    patchSessionMeta(sessionName, { lastTurn: 12 });
    patchSessionMeta(sessionName, { summary: "display only" });
    expect(loadSessionMeta(sessionName).lastTurn).toBe(12);
  });
});
