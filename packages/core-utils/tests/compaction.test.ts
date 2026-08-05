import { describe, expect, it } from "vitest";
import {
  COMPACTION_SUMMARY_MARKER,
  buildFilesDroppedMarker,
  isCompactionSummary,
  parseFilesDroppedMarker,
  stripCompactionMarker,
} from "../src/compaction.js";

describe("compaction helpers", () => {
  it("detects only when the marker is at the start", () => {
    expect(isCompactionSummary(`${COMPACTION_SUMMARY_MARKER}body`)).toBe(true);
    expect(isCompactionSummary("ok body")).toBe(false);
    expect(isCompactionSummary(`prefix ${COMPACTION_SUMMARY_MARKER}body`)).toBe(false);
    expect(isCompactionSummary("")).toBe(false);
    expect(isCompactionSummary(null)).toBe(false);
    expect(isCompactionSummary(undefined)).toBe(false);
  });

  it("strips the marker only when it is at the start", () => {
    expect(stripCompactionMarker(`${COMPACTION_SUMMARY_MARKER}body`)).toBe("body");
    expect(stripCompactionMarker("untouched")).toBe("untouched");
  });
});

describe("files-dropped marker", () => {
  it("round-trips paths through build + parse", () => {
    const marker = buildFilesDroppedMarker(["src/a.ts", "src\\win.ts"]);
    expect(parseFilesDroppedMarker(marker)).toEqual(["src/a.ts", "src\\win.ts"]);
  });

  it("parses multiple marker blocks and dedupes", () => {
    const text = `summary prose\n${buildFilesDroppedMarker(["src/a.ts", "src/b.ts"])}\nmore prose\n${buildFilesDroppedMarker(["src/b.ts", "src/c.ts"])}`;
    expect(parseFilesDroppedMarker(text)).toEqual(["src/a.ts", "src/b.ts", "src/c.ts"]);
  });

  it("returns nothing when no marker is present", () => {
    expect(parseFilesDroppedMarker("plain summary")).toEqual([]);
  });
});
