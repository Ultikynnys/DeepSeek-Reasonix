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

vi.mock("@huggingface/transformers", () => ({
  pipeline: (...args: unknown[]) => mockPipeline(...args),
  env: mockEnv,
}));

import { isWebGPUSupported, speechTranscriber, suppressOnnxOptimizerNoise } from "./transcriber";

describe("LocalSpeechTranscriber", () => {
  beforeEach(() => {
    localStorage.clear();
    mockPipeline.mockReset();
    mockEnv.backends.onnx.wasm.proxy = true;
    mockEnv.backends.onnx.wasm.wasmPaths = "";
    speechTranscriber.setModel("Xenova/whisper-base.en");
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

  it("omits task and language options for English-only models during transcribe", async () => {
    const fakePipe = vi.fn().mockResolvedValue({ text: "Recognized text" });
    mockPipeline.mockResolvedValueOnce(fakePipe);

    speechTranscriber.setModel("whisper-tiny.en");
    const dummyAudio = new Float32Array(16000);
    const result = await speechTranscriber.transcribe(dummyAudio);

    expect(result.text).toBe("Recognized text");
    expect(fakePipe).toHaveBeenCalledWith(dummyAudio, {
      return_timestamps: false,
    });
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
      "onnx-community/whisper-tiny.en",
      { device: "wasm", dtype: "q8" },
    );
  });

  it("passes repoId when downloading model", async () => {
    const fakePipe = vi.fn();
    mockPipeline.mockResolvedValueOnce(fakePipe);

    await speechTranscriber.downloadModel("Xenova/whisper-small.en");

    expect(mockEnv.backends.onnx.wasm.proxy).toBe(false);
    expect(mockPipeline).toHaveBeenCalledWith(
      "automatic-speech-recognition",
      "onnx-community/whisper-small.en",
      expect.objectContaining({ device: "wasm", dtype: "q8" }),
    );
  });

  it("selects webgpu device when GPU adapter is available", async () => {
    const fakePipe = vi.fn().mockResolvedValue({ text: "GPU output" });
    mockPipeline.mockResolvedValueOnce(fakePipe);

    const originalGpu = (navigator as unknown as { gpu?: unknown }).gpu;
    try {
      Object.defineProperty(navigator, "gpu", {
        value: {
          requestAdapter: vi.fn().mockResolvedValue({}),
        },
        configurable: true,
      });

      expect(await isWebGPUSupported()).toBe(true);

      speechTranscriber.setModel("Xenova/whisper-base.en");
      await speechTranscriber.getPipeline("Xenova/whisper-base.en");

      expect(mockPipeline).toHaveBeenCalledWith(
        "automatic-speech-recognition",
        "onnx-community/whisper-base.en",
        {
          device: "webgpu",
          dtype: { encoder_model: "fp32", decoder_model_merged: "q4" },
        },
      );
    } finally {
      Object.defineProperty(navigator, "gpu", {
        value: originalGpu,
        configurable: true,
      });
    }
  });

  it("suppresses ONNX Runtime graph optimizer noise while preserving real warnings", () => {
    const originalWarn = console.warn;
    const warnSpy = vi.fn();
    console.warn = warnSpy;

    suppressOnnxOptimizerNoise();

    // ONNX optimizer and EP assignment noise should be dropped:
    console.warn(
      "2026-09-05 00:04:11.843900 [W:onnxruntime:, graph.cc:3490 CleanUnusedInitializersAndNodeArgs] Removing initializer '/model/decoder/layers.8/encoder_attn_layer_norm/Constant_1_output_0'. It is not used by any node and should be removed from the model.",
    );
    console.warn(
      "2026-09-05 00:44:21.507599 [W:onnxruntime:, session_state.cc:1280 VerifyEachNodeIsAssignedToAnEp] Some nodes were not assigned to the preferred execution providers which may or may not have an negative impact on performance.",
    );
    expect(warnSpy).not.toHaveBeenCalled();

    // Legitimate warnings should still be emitted:
    console.warn("User microphone input is clipping.");
    expect(warnSpy).toHaveBeenCalledWith("User microphone input is clipping.");

    console.warn = originalWarn;
  });
});
