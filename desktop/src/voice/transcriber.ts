/**
 * Local offline speech-to-text transcription using the bundled Whisper-tiny.en model.
 */

export type TranscriberStatus = "idle" | "loading-model" | "transcribing" | "ready" | "error";

export interface TranscribeProgress {
  status: TranscriberStatus;
  detail?: string;
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
  private isInitializing = false;
  private initPromise: Promise<ASRPipeline> | null = null;
  private currentStatus: TranscriberStatus = "idle";
  private onStatusChange?: (progress: TranscribeProgress) => void;

  public get status(): TranscriberStatus {
    return this.currentStatus;
  }

  public setStatusListener(listener?: (progress: TranscribeProgress) => void): void {
    this.onStatusChange = listener;
  }

  private updateStatus(status: TranscriberStatus, detail?: string): void {
    this.currentStatus = status;
    if (this.onStatusChange) {
      this.onStatusChange({ status, detail });
    }
  }

  /**
   * Initializes the bundled ASR pipeline using @xenova/transformers.
   * Remote model downloads are disabled to enforce 100% offline bundled usage.
   */
  public async getPipeline(): Promise<ASRPipeline> {
    if (this.pipelineInstance) {
      return this.pipelineInstance;
    }
    if (this.initPromise) {
      return this.initPromise;
    }

    this.initPromise = (async () => {
      this.isInitializing = true;
      this.updateStatus("loading-model", "Loading bundled Whisper model...");

      try {
        const { pipeline, env } = await import("@xenova/transformers");

        // Enforce offline bundled assets:
        env.allowRemoteModels = false;
        env.allowLocalModels = true;
        env.localModelPath = "/models/";
        env.backends.onnx.wasm.wasmPaths = "/wasm/";

        // Silence onnxruntime's noisy "[W:onnxruntime:...] Removing initializer ..."
        // warnings during model graph optimization. Default is "warning".
        env.backends.onnx.logLevel = "error";

        // Load the local whisper-tiny.en model:
        const pipe = (await pipeline("automatic-speech-recognition", "whisper-tiny.en", {
          quantized: true,
        })) as unknown as ASRPipeline;

        this.pipelineInstance = pipe;
        this.updateStatus("ready");
        return pipe;
      } catch (err) {
        const details = errorDetails(err);
        this.updateStatus("error", details);
        throw new Error(`Failed to load bundled transcription model (${details}).`);
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
