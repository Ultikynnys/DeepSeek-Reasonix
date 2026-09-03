import { describe, expect, it, vi } from "vitest";
import { AudioRecorder, resampleAudio } from "./audio-recorder";

describe("resampleAudio", () => {
  it("returns original buffer when source and target sample rates match", () => {
    const input = new Float32Array([0.1, -0.2, 0.5, -0.8]);
    const output = resampleAudio(input, 16000, 16000);
    expect(output).toBe(input);
  });

  it("handles empty buffers gracefully", () => {
    const input = new Float32Array(0);
    const output = resampleAudio(input, 48000, 16000);
    expect(output.length).toBe(0);
  });

  it("downsamples 48kHz audio to 16kHz (3:1 ratio)", () => {
    const length48k = 4800; // 0.1s at 48kHz
    const input = new Float32Array(length48k);
    for (let i = 0; i < length48k; i++) {
      input[i] = Math.sin((i / 48000) * 2 * Math.PI * 440);
    }

    const output = resampleAudio(input, 48000, 16000);
    expect(output.length).toBe(1600); // 0.1s at 16kHz
    expect(output[0]).toBeCloseTo(input[0]!, 4);
  });

  it("upsamples 8kHz audio to 16kHz (1:2 ratio)", () => {
    const length8k = 800; // 0.1s at 8kHz
    const input = new Float32Array(length8k);
    for (let i = 0; i < length8k; i++) {
      input[i] = 0.5;
    }

    const output = resampleAudio(input, 8000, 16000);
    expect(output.length).toBe(1600);
    expect(output[100]).toBeCloseTo(0.5, 4);
  });
});

describe("AudioRecorder", () => {
  it("throws descriptive error when getUserMedia is unavailable", async () => {
    const originalNavigator = globalThis.navigator;
    try {
      // @ts-expect-error test override
      delete globalThis.navigator;
      const recorder = new AudioRecorder();
      await expect(recorder.start()).rejects.toThrow(/getUserMedia unavailable/i);
    } finally {
      globalThis.navigator = originalNavigator;
    }
  });

  it("maps permission denial error to clear message", async () => {
    const originalMediaDevices = navigator.mediaDevices;
    try {
      const err = new Error("Permission denied");
      err.name = "NotAllowedError";

      // @ts-expect-error test mock
      navigator.mediaDevices = {
        getUserMedia: vi.fn().mockRejectedValue(err),
      };

      const recorder = new AudioRecorder();
      await expect(recorder.start()).rejects.toThrow(/Microphone permission was denied/i);
    } finally {
      // @ts-expect-error restore
      navigator.mediaDevices = originalMediaDevices;
    }
  });

  it("maps missing device error to clear message", async () => {
    const originalMediaDevices = navigator.mediaDevices;
    try {
      const err = new Error("Requested device not found");
      err.name = "NotFoundError";

      // @ts-expect-error test mock
      navigator.mediaDevices = {
        getUserMedia: vi.fn().mockRejectedValue(err),
      };

      const recorder = new AudioRecorder();
      await expect(recorder.start()).rejects.toThrow(/No microphone device was found/i);
    } finally {
      // @ts-expect-error restore
      navigator.mediaDevices = originalMediaDevices;
    }
  });

  it("cancels cleanly when not recording", () => {
    const recorder = new AudioRecorder();
    expect(recorder.recording).toBe(false);
    expect(() => recorder.cancel()).not.toThrow();
  });
});
