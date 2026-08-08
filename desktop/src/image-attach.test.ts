// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";

// typedMentionImages only needs convertFileSrc as a default parameter — stub
// it so the real Tauri implementation never runs in the test env.
vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (p: string) => `asset://localhost${p}`,
}));

import { typedMentionImages } from "./image-attach";

describe("typedMentionImages", () => {
  it("strips a typed image mention and echoes an asset-protocol icon", () => {
    const out = typedMentionImages("explain @C:\\shots\\chart.png", "C:\\repo");
    expect(out.text).toBe("explain ");
    expect(out.images).toEqual(["asset://localhostC:\\shots\\chart.png"]);
  });

  it("resolves workspace-relative mentions to absolute paths", () => {
    const out = typedMentionImages("see @assets/shot.png", "C:\\repo", (p) => p);
    expect(out.text).toBe("see ");
    expect(out.images).toEqual(["C:\\repo/assets/shot.png"]);
  });

  it("keeps text and images untouched when there are no image mentions", () => {
    const out = typedMentionImages("read @notes.md and @shots/anim.gif", "C:\\repo");
    expect(out.text).toBe("read @notes.md and @shots/anim.gif");
    expect(out.images).toEqual([]);
  });

  it("passes the resolved path to an injected src function", () => {
    const toSrc = vi.fn((p: string) => `src:${p}`);
    typedMentionImages("@chart.png", "C:\\repo", toSrc);
    expect(toSrc).toHaveBeenCalledWith("C:\\repo/chart.png");
  });

  it("strips multiple mentions and keeps document order", () => {
    const out = typedMentionImages("@a.png and @b.webp", undefined, (p) => p);
    expect(out.text).toBe(" and ");
    expect(out.images).toEqual(["a.png", "b.webp"]);
  });
});
