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
    const originalNavigatorDesc = Object.getOwnPropertyDescriptor(globalThis, "navigator");
    try {
      Object.defineProperty(globalThis, "navigator", { value: undefined, configurable: true });
      const recorder = new AudioRecorder();
      await expect(recorder.start()).rejects.toThrow(/getUserMedia unavailable/i);
    } finally {
      if (originalNavigatorDesc) {
        Object.defineProperty(globalThis, "navigator", originalNavigatorDesc);
      }
    }
  });

  it("preserves technical details when microphone access is not allowed", async () => {
    const originalMediaDevices = navigator.mediaDevices;
    try {
      const err = new Error("Blocked by operating-system privacy settings");
      err.name = "NotAllowedError";

      // @ts-expect-error test mock
      navigator.mediaDevices = {
        getUserMedia: vi.fn().mockRejectedValue(err),
      };

      const recorder = new AudioRecorder();
      await expect(recorder.start()).rejects.toThrow(
        /Microphone access was not allowed.*name=NotAllowedError.*Blocked by operating-system privacy settings/i,
      );
    } finally {
      // @ts-expect-error restore
      navigator.mediaDevices = originalMediaDevices;
    }
  });

  it("preserves the failed constraint for overconstrained capture", async () => {
    const originalMediaDevices = navigator.mediaDevices;
    try {
      const err = Object.assign(new Error("Requested channel count is unavailable"), {
        name: "OverconstrainedError",
        constraint: "channelCount",
      });

      // @ts-expect-error test mock
      navigator.mediaDevices = {
        getUserMedia: vi.fn().mockRejectedValue(err),
      };

      const recorder = new AudioRecorder();
      await expect(recorder.start()).rejects.toThrow(
        /requested audio constraint.*name=OverconstrainedError.*constraint=channelCount/i,
      );
    } finally {
      // @ts-expect-error restore
      navigator.mediaDevices = originalMediaDevices;
    }
  });

  it("stops the acquired microphone track when audio processing setup fails", async () => {
    const originalMediaDevices = navigator.mediaDevices;
    const originalWindow = globalThis.window;
    const stop = vi.fn();
    try {
      // @ts-expect-error test mock
      navigator.mediaDevices = {
        getUserMedia: vi.fn().mockResolvedValue({ getTracks: () => [{ stop }] }),
      };
      // @ts-expect-error test mock
      globalThis.window = { AudioContext: undefined };

      const recorder = new AudioRecorder();
      await expect(recorder.start()).rejects.toThrow(
        /Microphone audio processing setup failed.*AudioContext is not supported/i,
      );
      expect(stop).toHaveBeenCalledOnce();
    } finally {
      // @ts-expect-error restore
      navigator.mediaDevices = originalMediaDevices;
      globalThis.window = originalWindow;
    }
  });

  it("cancels cleanly when not recording", () => {
    const recorder = new AudioRecorder();
    expect(recorder.recording).toBe(false);
    expect(() => recorder.cancel()).not.toThrow();
  });

  it("fails if audioWorklet is not supported on AudioContext", async () => {
    const originalMediaDevices = navigator.mediaDevices;
    const originalWindow = globalThis.window;
    const stop = vi.fn();
    try {
      // @ts-expect-error test mock
      navigator.mediaDevices = {
        getUserMedia: vi.fn().mockResolvedValue({ getTracks: () => [{ stop }] }),
      };
      class MockAudioContext {
        createMediaStreamSource() {
          return { connect: vi.fn(), disconnect: vi.fn() };
        }
        audioWorklet = undefined;
        close = vi.fn().mockResolvedValue(undefined);
      }
      // @ts-expect-error test mock
      globalThis.window = {
        AudioContext: MockAudioContext as unknown as typeof AudioContext,
      };

      const recorder = new AudioRecorder();
      await expect(recorder.start()).rejects.toThrow(
        /Microphone audio processing setup failed.*AudioWorklet is not supported/i,
      );
      expect(stop).toHaveBeenCalledOnce();
    } finally {
      // @ts-expect-error restore
      navigator.mediaDevices = originalMediaDevices;
      globalThis.window = originalWindow;
    }
  });

  it("captures audio using AudioWorkletNode and flushes on stop", async () => {
    const originalMediaDevices = navigator.mediaDevices;
    const originalWindow = globalThis.window;
    const originalUrl = globalThis.URL;
    const stopTrack = vi.fn();

    class MockWorkletNode {
      port = {
        onmessage: null as ((event: { data: unknown }) => void) | null,
        postMessage: vi.fn().mockImplementation((msg: unknown) => {
          if (msg === "flush" && this.port.onmessage) {
            this.port.onmessage({ data: new Float32Array([0.2, 0.4]) });
            this.port.onmessage({ data: { type: "flushed" } });
          }
        }),
      };
      connect = vi.fn();
      disconnect = vi.fn();
    }

    class MockAudioContext {
      sampleRate = 16000;
      state = "running";
      destination = {};
      createMediaStreamSource() {
        return { connect: vi.fn(), disconnect: vi.fn() };
      }
      audioWorklet = {
        addModule: vi.fn().mockResolvedValue(undefined),
      };
      close = vi.fn().mockResolvedValue(undefined);
    }

    try {
      // @ts-expect-error test mock
      navigator.mediaDevices = {
        getUserMedia: vi.fn().mockResolvedValue({ getTracks: () => [{ stop: stopTrack }] }),
      };
      // @ts-expect-error test mock
      globalThis.window = {
        AudioContext: MockAudioContext as unknown as typeof AudioContext,
        AudioWorkletNode: MockWorkletNode as unknown as typeof AudioWorkletNode,
      };
      // @ts-expect-error test mock
      globalThis.URL = {
        createObjectURL: vi.fn().mockReturnValue("blob:mock-url"),
        revokeObjectURL: vi.fn(),
      };

      let lastVolume = 0;
      const recorder = new AudioRecorder({
        onVolumeChange: (vol) => {
          lastVolume = vol;
        },
      });

      await recorder.start();
      expect(recorder.recording).toBe(true);

      // Simulate incoming audio buffer chunk from worklet
      // @ts-expect-error accessing private workletNode for test simulation
      recorder.workletNode.port.onmessage({ data: new Float32Array([0.1, -0.1, 0.2, -0.2]) });
      expect(lastVolume).toBeGreaterThan(0);

      const result = await recorder.stop();
      expect(recorder.recording).toBe(false);
      expect(result.audioData.length).toBe(6); // 4 initial + 2 flushed
      expect(stopTrack).toHaveBeenCalled();
    } finally {
      // @ts-expect-error restore
      navigator.mediaDevices = originalMediaDevices;
      globalThis.window = originalWindow;
      globalThis.URL = originalUrl;
    }
  });
});
