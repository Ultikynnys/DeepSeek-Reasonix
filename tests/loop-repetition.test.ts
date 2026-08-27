import { describe, expect, it } from "vitest";
import { StreamRepetitionDetector } from "../src/loop/repetition.js";

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

  it("does not flag short repetitions or ordinary prose", () => {
    expect(detect(["ha".repeat(400)])).toBeNull();
    expect(detect(["0123456789abcdef".repeat(60)])).toBeNull();
    expect(
      detect([
        "The model checked the source folder, compared the files, and explained what was missing.",
      ]),
    ).toBeNull();
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
