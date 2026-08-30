import { describe, expect, it, vi } from "vitest";
import { SessionListCache } from "../src/desktop/session-list-cache.js";

describe("SessionListCache", () => {
  it("coalesces concurrent workspace loads and reuses the result", async () => {
    let complete!: (value: string[]) => void;
    const loader = vi.fn(
      () =>
        new Promise<string[]>((done) => {
          complete = done;
        }),
    );
    const cache = new SessionListCache(loader);
    const first = cache.load(".");
    const second = cache.load("./");
    expect(first.cache).toBe("miss");
    expect(second.cache).toBe("inflight");
    complete(["session"]);
    await expect(Promise.all([first.value, second.value])).resolves.toEqual([
      ["session"],
      ["session"],
    ]);
    expect(cache.load(".").cache).toBe("hit");
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it("invalidates one workspace or all workspaces", async () => {
    const loader = vi.fn(async (workspace: string) => [workspace]);
    const cache = new SessionListCache(loader);
    await cache.load("a").value;
    await cache.load("b").value;
    cache.invalidate("a");
    await cache.load("a").value;
    expect(cache.load("b").cache).toBe("hit");
    cache.invalidate();
    expect(cache.load("b").cache).toBe("miss");
  });

  it("expires successful entries", async () => {
    let now = 0;
    const loader = vi.fn(async () => [] as string[]);
    const cache = new SessionListCache(loader, 100, () => now);
    await cache.load(".").value;
    now = 101;
    await cache.load(".").value;
    expect(loader).toHaveBeenCalledTimes(2);
  });
});
