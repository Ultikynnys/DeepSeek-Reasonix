import { describe, expect, it } from "vitest";
import { speechTranscriber } from "./transcriber";

describe("LocalSpeechTranscriber", () => {
  it("initializes with idle status", () => {
    expect(speechTranscriber.status).toBe("idle");
  });

  it("returns empty text for empty audio buffer without initializing pipeline", async () => {
    const emptyBuffer = new Float32Array(0);
    const result = await speechTranscriber.transcribe(emptyBuffer);
    expect(result.text).toBe("");
  });

  it("returns empty text for audio buffers shorter than 200ms", async () => {
    // 16000 * 0.1 = 1600 samples (100ms)
    const shortBuffer = new Float32Array(1600);
    const result = await speechTranscriber.transcribe(shortBuffer);
    expect(result.text).toBe("");
  });
});
