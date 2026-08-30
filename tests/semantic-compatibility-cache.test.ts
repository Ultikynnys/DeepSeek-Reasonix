import { describe, expect, it, vi } from "vitest";
import { SemanticCompatibilityCache } from "../src/index/semantic/compatibility-cache.js";

describe("SemanticCompatibilityCache", () => {
  it("coalesces normalized roots and caches completed checks", async () => {
    let complete!: (value: boolean) => void;
    const check = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          complete = resolve;
        }),
    );
    const cache = new SemanticCompatibilityCache(check);
    const first = cache.get(".");
    const second = cache.get("./");
    expect(check).toHaveBeenCalledTimes(1);
    complete(true);
    await expect(Promise.all([first, second])).resolves.toEqual([true, true]);
    await cache.get(".");
    expect(check).toHaveBeenCalledTimes(1);
  });

  it("invalidates one root and retries rejected checks", async () => {
    const check = vi.fn().mockRejectedValueOnce(new Error("disk")).mockResolvedValue(true);
    const cache = new SemanticCompatibilityCache(check);
    await expect(cache.get(".")).rejects.toThrow("disk");
    await expect(cache.get(".")).resolves.toBe(true);
    cache.invalidate(".");
    await expect(cache.get(".")).resolves.toBe(true);
    expect(check).toHaveBeenCalledTimes(3);
  });
});
