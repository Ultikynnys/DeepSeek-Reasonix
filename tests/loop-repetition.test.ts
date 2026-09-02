import { describe, expect, it } from "vitest";
import { StreamRepetitionDetector } from "../src/loop/repetition.js";
import { MATERIAL_REASONING_LOOP } from "./support/repetition-fixtures.js";

function detect(chunks: string[]) {
  const detector = new StreamRepetitionDetector();
  for (const chunk of chunks) {
    const result = detector.append(chunk);
    if (result) return result;
  }
  return null;
}

describe("StreamRepetitionDetector", () => {
  it("detects a long repeated word", () => {
    const result = detect(["Let me find it:", "wright".repeat(200)]);

    expect(result).toMatchObject({ period: 6, safeLength: 15 });
    expect(result!.repeatedChars).toBeGreaterThanOrEqual(1024);
  });

  it("detects repetition across arbitrary stream chunks", () => {
    const text = `useful prefix ${"wright".repeat(200)}`;
    const chunks = Array.from({ length: Math.ceil(text.length / 7) }, (_, i) =>
      text.slice(i * 7, i * 7 + 7),
    );

    expect(detect(chunks)?.safeLength).toBe("useful prefix ".length);
  });

  it("detects a repeated unit despite variable whitespace", () => {
    const unit = "tool_result";
    const repeated = Array.from({ length: 120 }, (_, i) => {
      if (i % 5 === 0) return unit;
      if (i % 3 === 0) return `${unit}\n\n`;
      return `${unit}\n`;
    }).join("");
    const text = `useful prefix\n${repeated}`;
    const chunks = Array.from({ length: Math.ceil(text.length / 13) }, (_, i) =>
      text.slice(i * 13, i * 13 + 13),
    );

    expect(detect(chunks)).toMatchObject({
      period: unit.length,
      safeLength: "useful prefix\n".length,
    });
  });

  it("detects an alternating repeated sentence block", () => {
    const first =
      'Actually, "loss" might be a specific animation sequence. Let me look at the animation qci file. But first, let me understand the eyeball setup.\n\n';
    const second =
      "Let me look at the animation qci file. But first, let me understand the eyeball setup.\n\n";
    const prefix =
      "Let me look at the animation qci file. But first, let me understand the eyeball setup.\n\n";
    const text = `${prefix}${`${first}${second}`.repeat(20)}`;
    const chunks = Array.from({ length: Math.ceil(text.length / 29) }, (_, i) =>
      text.slice(i * 29, i * 29 + 29),
    );

    expect(detect(chunks)?.safeLength).toBe(0);
  });

  it("detects a repeated multi-paragraph reasoning cycle larger than maxPeriod", () => {
    expect(MATERIAL_REASONING_LOOP.replace(/\s/gu, "").length).toBeGreaterThan(1024);
    const prefix = "Verified setup facts ZXQJ\n\n";
    const text = `${prefix}${MATERIAL_REASONING_LOOP.repeat(4)}`;
    const chunks = Array.from({ length: Math.ceil(text.length / 53) }, (_, i) =>
      text.slice(i * 53, i * 53 + 53),
    );

    expect(detect(chunks)?.safeLength).toBe(prefix.length);
  });

  it("detects repeating words early with word-bias", () => {
    // A word like "read_file" (period 9) should trigger after ~8 repeats (72 chars), not waiting for 1024 chars.
    const chunks = ["Let me check: ", ...Array.from({ length: 12 }, () => "read_file")];
    const detector = new StreamRepetitionDetector();
    let detectedAtChunk = -1;
    for (let i = 0; i < chunks.length; i++) {
      const res = detector.append(chunks[i]!);
      if (res) {
        detectedAtChunk = i;
        expect(res.period).toBe(9);
        expect(res.safeLength).toBe("Let me check: ".length);
        expect(res.repeatedChars).toBeLessThan(150);
        break;
      }
    }
    // Should be detected around chunk 8 (72 chars of read_file), well before chunk 12
    expect(detectedAtChunk).toBeGreaterThanOrEqual(7);
    expect(detectedAtChunk).toBeLessThanOrEqual(9);
  });

  it("does not flag short repetitions or ordinary prose", () => {
    expect(detect(["ha".repeat(15)])).toBeNull();
    expect(detect(["0123456789abcdef".repeat(2)])).toBeNull();
    expect(detect(["-".repeat(80)])).toBeNull(); // Standard divider line
    expect(detect(["../".repeat(10)])).toBeNull(); // Deep relative path
    expect(
      detect([
        "The model checked the source folder, compared the files, and explained what was missing.",
      ]),
    ).toBeNull();
    const largeUniqueProse = Array.from(
      { length: 240 },
      (_, i) =>
        `Finding ${i}: inspected artifact ${i * 17}, compared unique path segment ${i * 31}, and recorded distinct evidence ${i * 47}.`,
    ).join("\n");
    expect(detect([largeUniqueProse])).toBeNull();
  });

  it("detects long repeating cycles", () => {
    expect(detect(["ha".repeat(400)])).toMatchObject({ period: 2, safeLength: 0 });
    expect(detect(["0123456789abcdef".repeat(60)])).toMatchObject({ period: 16, safeLength: 0 });
  });

  it("keeps memory bounded while preserving absolute safe offsets", () => {
    const detector = new StreamRepetitionDetector({
      minRepeatedChars: 256,
      minRepeats: 12,
      maxBufferChars: 512,
    });
    expect(detector.append("x".repeat(5000))).toMatchObject({ safeLength: 0, period: 1 });
  });
});
