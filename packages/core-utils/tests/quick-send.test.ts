import { describe, expect, it } from "vitest";
import {
  BUILTIN_QUICK_SENDS,
  QUICK_SEND_SHORTHAND_MAX_LENGTH,
  allQuickSends,
  enforceQuickSendShorthand,
  isQuickSend,
  resolveActiveQuickSend,
} from "../src/index.js";

describe("quick send shorthand enforcement", () => {
  it("enforces a maximum character length of 20", () => {
    expect(QUICK_SEND_SHORTHAND_MAX_LENGTH).toBe(20);
  });

  it("trims and clamps shorthand text to 20 chars", () => {
    expect(enforceQuickSendShorthand("  proceed  ")).toBe("proceed");
    expect(enforceQuickSendShorthand("commit and push all changes")).toBe("commit and push all ");
    expect(enforceQuickSendShorthand("12345678901234567890extra")).toBe("12345678901234567890");
    expect(enforceQuickSendShorthand("")).toBe("");
  });

  it("enforces shorthand length in allQuickSends and resolveActiveQuickSend", () => {
    const custom = {
      id: "custom-1",
      label: "Deploy to production immediately",
      message: "deploy production",
      shorthand: "Deploy to production immediately",
    };
    const sends = allQuickSends([custom]);
    const found = sends.find((s) => s.id === "custom-1");
    expect(found).toBeDefined();
    expect(found!.shorthand).toBe("Deploy to production");
    expect(found!.shorthand.length).toBeLessThanOrEqual(20);

    const active = resolveActiveQuickSend("custom-1", [custom]);
    expect(active.shorthand).toBe("Deploy to production");
    expect(active.shorthand.length).toBeLessThanOrEqual(20);
  });

  it("falls back to clamped label if shorthand is empty in allQuickSends", () => {
    const custom = {
      id: "custom-2",
      label: "Run test suite and check exit",
      message: "run tests",
      shorthand: "",
    };
    const sends = allQuickSends([custom]);
    const found = sends.find((s) => s.id === "custom-2");
    expect(found!.shorthand).toBe("Run test suite and c");
  });
});
