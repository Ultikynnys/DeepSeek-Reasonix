import { describe, expect, it } from "vitest";
import { speechTranscriber } from "./transcriber";

describe("LocalSpeechTranscriber", () => {
  it("initializes with idle status", () => {
    expect(speechTranscriber.status).toBe("idle");
  });

  it("reports when no microphone audio was captured", async () => {
    await expect(speechTranscriber.transcribe(new Float32Array(0))).rejects.toThrow(
      "No microphone audio was captured.",
    );
  });

  it("reports the captured duration when audio is shorter than 200 ms", async () => {
    await expect(speechTranscriber.transcribe(new Float32Array(1600))).rejects.toThrow(
      "Recording was too short to transcribe (100 ms captured; minimum is 200 ms).",
    );
  });
});
