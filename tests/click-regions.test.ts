import { afterEach, describe, expect, it } from "vitest";
import {
  clearClickRegions,
  hitTestClickRegion,
  setClickRegions,
} from "../src/cli/ui/state/click-regions.js";

describe("click-regions hit-testing (TUI Stop button)", () => {
  afterEach(clearClickRegions);

  it("matches the card whose Stop-button row was clicked", () => {
    setClickRegions([
      { cardId: "call-1", row: 5 },
      { cardId: "call-2", row: 12 },
    ]);
    expect(hitTestClickRegion(5)).toBe("call-1");
    expect(hitTestClickRegion(12)).toBe("call-2");
    expect(hitTestClickRegion(4)).toBeNull();
    expect(hitTestClickRegion(13)).toBeNull();
  });

  it("empty regions hit nothing", () => {
    setClickRegions([]);
    expect(hitTestClickRegion(1)).toBeNull();
  });

  it("clearClickRegions drops all regions", () => {
    setClickRegions([{ cardId: "call-1", row: 5 }]);
    clearClickRegions();
    expect(hitTestClickRegion(5)).toBeNull();
  });

  it("re-publishing replaces the table wholesale", () => {
    setClickRegions([{ cardId: "call-1", row: 5 }]);
    setClickRegions([{ cardId: "call-9", row: 9 }]);
    expect(hitTestClickRegion(5)).toBeNull();
    expect(hitTestClickRegion(9)).toBe("call-9");
  });
});
