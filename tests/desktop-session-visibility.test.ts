import { describe, expect, it } from "vitest";
import { sessionVisibleInList } from "../src/cli/commands/desktop.js";

describe("sessionVisibleInList — lazy-minted current session stays visible", () => {
  it("shows a non-empty session regardless of which session is current", () => {
    expect(sessionVisibleInList({ name: "s1", messageCount: 3 }, "other")).toBe(true);
    expect(sessionVisibleInList({ name: "s1", messageCount: 3 }, undefined)).toBe(true);
  });

  it("shows an empty session only when it is the tab's current conversation", () => {
    expect(sessionVisibleInList({ name: "fresh", messageCount: 0 }, "fresh")).toBe(true);
    expect(sessionVisibleInList({ name: "fresh", messageCount: 0 }, "other")).toBe(false);
    expect(sessionVisibleInList({ name: "fresh", messageCount: 0 }, undefined)).toBe(false);
  });
});
