// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";

const mockPipeline = vi.fn();
const mockEnv = {
  allowRemoteModels: false,
  allowLocalModels: true,
  backends: {
    onnx: {
      logLevel: "info",
      wasm: {
        wasmPaths: "",
        proxy: true,
      },
    },
  },
};

vi.mock("@xenova/transformers", () => ({
  pipeline: (...args: unknown[]) => mockPipeline(...args),
  env: mockEnv,
}));

import { speechTranscriber } from "./transcriber";

describe("LocalSpeechTranscriber", () => {
  beforeEach(() => {
    localStorage.clear();
    mockPipeline.mockReset();
    mockEnv.backends.onnx.wasm.proxy = true;
    mockEnv.backends.onnx.wasm.wasmPaths = "";
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

  it("configures transformers env with proxy=false and loads using repoId", async () => {
    const fakePipe = vi.fn().mockResolvedValue({ text: "Hello world" });
    mockPipeline.mockResolvedValueOnce(fakePipe);

    const pipe = await speechTranscriber.getPipeline("whisper-tiny.en");
    expect(pipe).toBe(fakePipe);

    expect(mockEnv.backends.onnx.wasm.proxy).toBe(false);
    expect(mockEnv.backends.onnx.wasm.wasmPaths).toBe("/wasm/");
    expect(mockEnv.allowRemoteModels).toBe(true);
    expect(mockEnv.allowLocalModels).toBe(false);

    expect(mockPipeline).toHaveBeenCalledWith(
      "automatic-speech-recognition",
      "Xenova/whisper-tiny.en",
      { quantized: true },
    );
  });

  it("passes repoId when downloading model", async () => {
    const fakePipe = vi.fn();
    mockPipeline.mockResolvedValueOnce(fakePipe);

    await speechTranscriber.downloadModel("Xenova/whisper-small.en");

    expect(mockEnv.backends.onnx.wasm.proxy).toBe(false);
    expect(mockPipeline).toHaveBeenCalledWith(
      "automatic-speech-recognition",
      "Xenova/whisper-small.en",
      expect.objectContaining({ quantized: true }),
    );
  });
});
