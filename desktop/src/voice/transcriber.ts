/**
 * Local speech-to-text transcription with selectable Whisper models.
 * Default is the bundled offline Whisper-tiny.en model.
 * Optional higher-accuracy models (Base and Small) can be downloaded directly in-app.
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
    if (opt.isBundled) {
      markVoiceModelDownloaded(modelId, true);
      return;
    }

    this.updateStatus("downloading", `Downloading ${opt.name}...`);

    try {
      const { pipeline, env } = await import("@xenova/transformers");

      env.allowRemoteModels = true;
      env.allowLocalModels = false;
      env.backends.onnx.wasm.wasmPaths = "/wasm/";
      env.backends.onnx.logLevel = "error";

      const pipe = (await pipeline("automatic-speech-recognition", modelId, {
        quantized: true,
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
   * Initializes the ASR pipeline for the target model.
   * Bundled models use local assets; downloaded models use local cache.
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
      this.updateStatus("loading-model", `Loading ${opt.name}...`);

      try {
        const { pipeline, env } = await import("@xenova/transformers");

        env.backends.onnx.wasm.wasmPaths = "/wasm/";
        env.backends.onnx.logLevel = "error";

        if (opt.isBundled) {
          env.allowRemoteModels = false;
          env.allowLocalModels = true;
          env.localModelPath = "/models/";
        } else {
          env.allowRemoteModels = true;
          env.allowLocalModels = false;
        }

        const pipe = (await pipeline("automatic-speech-recognition", modelId, {
          quantized: true,
        })) as unknown as ASRPipeline;

        this.pipelineInstance = pipe;
        this.loadedModelId = modelId;
        if (!opt.isBundled) {
          markVoiceModelDownloaded(modelId, true);
        }
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
      const output = await pipe(audioData, {
        language: "english",
        task: "transcribe",
        return_timestamps: false,
      });

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
