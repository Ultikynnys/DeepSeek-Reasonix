import { describe, expect, it } from "vitest";
import { areWorkspacesLoaded } from "../desktop/src/workspace-loading";

describe("desktop workspace loading lifecycle", () => {
  it("waits for every workspace UI to acknowledge initialization", () => {
    const expected = new Set(["tab-a", "tab-b"]);

    expect(areWorkspacesLoaded(expected, new Set())).toBe(false);
    expect(areWorkspacesLoaded(expected, new Set(["tab-a"]))).toBe(false);
    expect(areWorkspacesLoaded(expected, new Set(["tab-a", "tab-b"]))).toBe(true);
  });

  it("does not complete before the tabs snapshot defines the expected workspaces", () => {
    expect(areWorkspacesLoaded(null, new Set(["tab-a"]))).toBe(false);
  });

  it("allows an empty authoritative workspace snapshot to complete", () => {
    expect(areWorkspacesLoaded(new Set(), new Set())).toBe(true);
  });
});
