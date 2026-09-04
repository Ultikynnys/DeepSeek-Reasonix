// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from "vitest";
import { speechTranscriber } from "./transcriber";

describe("LocalSpeechTranscriber", () => {
  beforeEach(() => {
    localStorage.clear();
    speechTranscriber.setModel("whisper-tiny.en");
  });

  it("initializes with idle status and default tiny model", () => {
    expect(speechTranscriber.status).toBe("idle");
    expect(speechTranscriber.activeModel).toBe("whisper-tiny.en");
  });

  it("updates active model via setModel", () => {
    speechTranscriber.setModel("Xenova/whisper-base.en");
    expect(speechTranscriber.activeModel).toBe("Xenova/whisper-base.en");
    expect(localStorage.getItem("reasonix.voiceModel")).toBe("Xenova/whisper-base.en");
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
