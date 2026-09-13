import { describe, expect, it } from "vitest";
import { hitPercent } from "./format";

describe("hitPercent", () => {
  it("keeps one decimal instead of rounding to a whole percentage", () => {
    expect(hitPercent(996, 4)).toBe("99.6");
  });

  it("never rounds a near-total hit rate up to an impossible 100.0", () => {
    // 999,838 / (999,838 + 162) = 99.984% real — a whole-percent round shows "100%".
    expect(hitPercent(999_838, 162)).toBe("99.9");
    expect(hitPercent(1_000_000, 1)).toBe("99.9");
  });

  it("shows 100.0 only when the miss count is exactly zero", () => {
    expect(hitPercent(500, 0)).toBe("100.0");
  });

  it("returns 0.0 with no data", () => {
    expect(hitPercent(0, 0)).toBe("0.0");
    expect(hitPercent(Number.NaN, undefined as unknown as number)).toBe("0.0");
  });

  it("handles a pure miss", () => {
    expect(hitPercent(0, 100)).toBe("0.0");
  });
});
