/**
 * Local speech-to-text transcription with selectable Whisper models.
 * Models are downloaded on demand into the local browser cache.
 */

import {
  type VoiceModelId,
  getActiveVoiceModelId,
  getVoiceModelOption,
  markVoiceModelDownloaded,
  setActiveVoiceModelId,
} from "./models";

export type TranscriberStatus =
  | "idle"
  | "loading-model"
  | "downloading"
  | "transcribing"
  | "ready"
  | "error";

export interface TranscribeProgress {
  status: TranscriberStatus;
  detail?: string;
  progress?: number;
}

export interface DownloadProgress {
  status: "initiate" | "download" | "progress" | "done" | "ready";
  file?: string;
  progress?: number;
  loaded?: number;
  total?: number;
}

export interface TranscribeResult {
  text: string;
}

function errorDetails(err: unknown): string {
  if (!(err instanceof Error)) {
    return `unknown error: ${String(err)}`;
  }
  return `name=${err.name || "Error"}, message=${err.message || "No message"}`;
}

type ASRPipeline = (
  audio: Float32Array,
  options?: Record<string, unknown>,
) => Promise<{ text: string } | string>;

type TransformersEnv = typeof import("@huggingface/transformers").env;

const ONNX_NOISE_MARKER = Symbol.for("reasonix.onnxNoiseSuppressed");

/**
 * Suppresses repetitive ONNX Runtime graph-optimizer noise.
 * During model loading, ONNX Runtime logs hundreds of "Removing initializer"
 * warnings for unused graph nodes, which floods the browser developer console.
 */
export function suppressOnnxOptimizerNoise(): void {
  if (typeof console === "undefined") return;

  if (console.warn && !(console.warn as unknown as Record<symbol, unknown>)[ONNX_NOISE_MARKER]) {
    const originalWarn = console.warn;
    const filteredWarn = (...args: unknown[]) => {
      const first = args[0];
      if (
        typeof first === "string" &&
        (first.includes("CleanUnusedInitializersAndNodeArgs") ||
          first.includes("VerifyEachNodeIsAssignedToAnEp") ||
          (first.includes("[W:onnxruntime:") && first.includes("Removing initializer")))
      ) {
        return;
      }
      originalWarn.apply(console, args);
    };
    (filteredWarn as unknown as Record<symbol, unknown>)[ONNX_NOISE_MARKER] = true;
    console.warn = filteredWarn;
  }

  if (console.log && !(console.log as unknown as Record<symbol, unknown>)[ONNX_NOISE_MARKER]) {
    const originalLog = console.log;
    const filteredLog = (...args: unknown[]) => {
      const first = args[0];
      if (
        typeof first === "string" &&
        (first.includes("CleanUnusedInitializersAndNodeArgs") ||
          first.includes("VerifyEachNodeIsAssignedToAnEp") ||
          (first.includes("[W:onnxruntime:") && first.includes("Removing initializer")))
      ) {
        return;
      }
      originalLog.apply(console, args);
    };
    (filteredLog as unknown as Record<symbol, unknown>)[ONNX_NOISE_MARKER] = true;
    console.log = filteredLog;
  }

  if (console.error && !(console.error as unknown as Record<symbol, unknown>)[ONNX_NOISE_MARKER]) {
    const originalError = console.error;
    const filteredError = (...args: unknown[]) => {
      const first = args[0];
      if (
        typeof first === "string" &&
        (first.includes("CleanUnusedInitializersAndNodeArgs") ||
          first.includes("VerifyEachNodeIsAssignedToAnEp") ||
          (first.includes("[W:onnxruntime:") && first.includes("Removing initializer")))
      ) {
        return;
      }
      originalError.apply(console, args);
    };
    (filteredError as unknown as Record<symbol, unknown>)[ONNX_NOISE_MARKER] = true;
    console.error = filteredError;
  }
}

/**
 * Applies the Transformers.js environment configuration used for in-app
 * transcription.
 *
 * Runs ONNX Runtime directly with WebAssembly. Proxy mode is disabled because
 * onnxruntime-web proxying uses Webpack worker-loader and causes concurrent
 * session allocation errors during Seq2Seq encoder/decoder construction.
 */
function configureTransformersEnv(env: TransformersEnv): void {
  suppressOnnxOptimizerNoise();
  env.allowRemoteModels = true;
  env.allowLocalModels = false;
  const wasm = env.backends.onnx?.wasm;
  if (wasm) {
    wasm.wasmPaths = "/wasm/";
    wasm.proxy = false;
  }
  if (env.backends.onnx) {
    env.backends.onnx.logLevel = "error";
  }
}

interface WebGPUNavigator {
  gpu?: {
    requestAdapter(options?: { powerPreference?: string }): Promise<{
      info?: Record<string, string>;
      requestAdapterInfo?: () => Promise<Record<string, string>>;
    } | null>;
  };
}

/**
 * Detects whether the device has a valid GPU with WebGPU compute support.
 */
export async function isWebGPUSupported(): Promise<boolean> {
  if (typeof navigator === "undefined") {
    return false;
  }
  const nav = navigator as unknown as WebGPUNavigator;
  if (!nav.gpu || typeof nav.gpu.requestAdapter !== "function") {
    return false;
  }
  try {
    const adapter = await nav.gpu.requestAdapter({ powerPreference: "high-performance" });
    if (!adapter) {
      return false;
    }
    const info = adapter.info ?? (await adapter.requestAdapterInfo?.());
    if (info) {
      const parts = [info.vendor, info.architecture, info.description].filter(Boolean);
      if (parts.length > 0) {
        console.info(`[Voice] WebGPU hardware adapter: ${parts.join(" ")}`);
      }
    }
    return true;
  } catch {
    return false;
  }
}

class LocalSpeechTranscriber {
  private pipelineInstance: ASRPipeline | null = null;
  private loadedModelId: VoiceModelId | null = null;
  private activeModelId: VoiceModelId = getActiveVoiceModelId();
  private isInitializing = false;
  private initPromise: Promise<ASRPipeline> | null = null;
  private currentStatus: TranscriberStatus = "idle";
  private onStatusChange?: (progress: TranscribeProgress) => void;

  public get status(): TranscriberStatus {
    return this.currentStatus;
  }

  public get activeModel(): VoiceModelId {
    return this.activeModelId;
  }

  public setModel(modelId: VoiceModelId): void {
    if (this.activeModelId === modelId) {
      return;
    }
    this.activeModelId = modelId;
    setActiveVoiceModelId(modelId);
    if (this.loadedModelId !== modelId) {
      this.pipelineInstance = null;
      this.loadedModelId = null;
      this.currentStatus = "idle";
    }
  }

  public setStatusListener(listener?: (progress: TranscribeProgress) => void): void {
    this.onStatusChange = listener;
  }

  private updateStatus(status: TranscriberStatus, detail?: string, progress?: number): void {
    this.currentStatus = status;
    if (this.onStatusChange) {
      this.onStatusChange({ status, detail, progress });
    }
  }

  /**
   * Downloads a model into the local browser cache with progress reporting.
   */
  public async downloadModel(
    modelId: VoiceModelId,
    onProgress?: (progress: DownloadProgress) => void,
  ): Promise<void> {
    const opt = getVoiceModelOption(modelId);

    this.updateStatus("downloading", `Downloading ${opt.name}...`);

    try {
      const { pipeline, env } = await import("@huggingface/transformers");

      configureTransformersEnv(env);

      const hasGpu = await isWebGPUSupported();
      const pipe = (await pipeline("automatic-speech-recognition", opt.repoId, {
        device: hasGpu ? "webgpu" : "wasm",
        dtype: hasGpu ? { encoder_model: "fp32", decoder_model_merged: "q4" } : "q8",
        progress_callback: (data: unknown) => {
          if (onProgress && data && typeof data === "object") {
            onProgress(data as DownloadProgress);
          }
        },
      })) as unknown as ASRPipeline;

      markVoiceModelDownloaded(modelId, true);

      // If downloading the currently active model, retain the initialized pipeline:
      if (this.activeModelId === modelId) {
        this.pipelineInstance = pipe;
        this.loadedModelId = modelId;
        this.updateStatus("ready");
      } else {
        this.updateStatus("idle");
      }
    } catch (err) {
      const details = errorDetails(err);
      this.updateStatus("error", details);
      throw new Error(`Failed to download voice model ${opt.name} (${details}).`);
    }
  }

  /**
   * Initializes the ASR pipeline for the target model, downloading it on first use.
   */
  public async getPipeline(targetModelId?: VoiceModelId): Promise<ASRPipeline> {
    const modelId = targetModelId ?? this.activeModelId;

    if (this.pipelineInstance && this.loadedModelId === modelId) {
      return this.pipelineInstance;
    }
    if (this.initPromise) {
      return this.initPromise;
    }

    const opt = getVoiceModelOption(modelId);

    this.initPromise = (async () => {
      this.isInitializing = true;
      const hasGpu = await isWebGPUSupported();
      this.updateStatus("loading-model", `Loading ${opt.name} (${hasGpu ? "GPU" : "CPU"})...`);

      try {
        const { pipeline, env } = await import("@huggingface/transformers");

        configureTransformersEnv(env);

        const pipe = (await pipeline("automatic-speech-recognition", opt.repoId, {
          device: hasGpu ? "webgpu" : "wasm",
          dtype: hasGpu ? { encoder_model: "fp32", decoder_model_merged: "q4" } : "q8",
        })) as unknown as ASRPipeline;

        this.pipelineInstance = pipe;
        this.loadedModelId = modelId;
        markVoiceModelDownloaded(modelId, true);
        this.updateStatus("ready");
        return pipe;
      } catch (err) {
        const details = errorDetails(err);
        this.updateStatus("error", details);
        throw new Error(`Failed to load transcription model ${opt.name} (${details}).`);
      } finally {
        this.isInitializing = false;
        this.initPromise = null;
      }
    })();

    return this.initPromise;
  }

  /**
   * Transcribes a 16 kHz Float32Array audio buffer into text.
   */
  public async transcribe(
    audioData: Float32Array,
    options?: { onProgress?: (status: TranscribeProgress) => void },
  ): Promise<TranscribeResult> {
    if (audioData.length === 0) {
      throw new Error("No microphone audio was captured.");
    }

    const minSamples = 16000 * 0.2; // 200 ms minimum audio
    if (audioData.length < minSamples) {
      const durationMs = Math.round((audioData.length / 16000) * 1000);
      throw new Error(
        `Recording was too short to transcribe (${durationMs} ms captured; minimum is 200 ms).`,
      );
    }

    const pipe = await this.getPipeline();

    this.updateStatus("transcribing", "Transcribing speech...");
    if (options?.onProgress) {
      options.onProgress({ status: "transcribing", detail: "Transcribing speech..." });
    }

    try {
      const isEnglishOnly = this.activeModelId.endsWith(".en");
      const generateOptions: Record<string, unknown> = {
        return_timestamps: false,
        ...(isEnglishOnly ? {} : { language: "english", task: "transcribe" }),
      };

      const output = await pipe(audioData, generateOptions);

      let rawText: string;
      if (typeof output === "string") {
        rawText = output;
      } else if (output && typeof output.text === "string") {
        rawText = output.text;
      } else {
        throw new Error(
          `Speech recognizer returned an unsupported result (${Object.prototype.toString.call(output)}).`,
        );
      }

      const text = rawText.trim();
      if (!text) {
        throw new Error("No speech was recognized in the recording.");
      }
      this.updateStatus("ready");
      return { text };
    } catch (err) {
      const details = errorDetails(err);
      this.updateStatus("error", details);
      throw new Error(`Speech transcription failed (${details}).`);
    }
  }

  /**
   * Pre-warms the transcription model into memory in the background.
   */
  public async preload(): Promise<void> {
    if (!this.pipelineInstance && !this.isInitializing) {
      await this.getPipeline();
    }
  }
}

export const speechTranscriber = new LocalSpeechTranscriber();
