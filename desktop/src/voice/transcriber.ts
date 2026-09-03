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

        // Load the local whisper-tiny.en model:
        const pipe = (await pipeline("automatic-speech-recognition", "whisper-tiny.en", {
          quantized: true,
        })) as unknown as ASRPipeline;

        this.pipelineInstance = pipe;
        this.updateStatus("ready");
        return pipe;
      } catch (err) {
        this.updateStatus("error", (err as Error).message);
        throw new Error(`Failed to load bundled transcription model: ${(err as Error).message}`);
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
      return { text: "" };
    }

    const minSamples = 16000 * 0.2; // 200 ms minimum audio
    if (audioData.length < minSamples) {
      return { text: "" };
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

      let rawText = "";
      if (typeof output === "string") {
        rawText = output;
      } else if (output && typeof output.text === "string") {
        rawText = output.text;
      }

      const text = rawText.trim();
      this.updateStatus("ready");
      return { text };
    } catch (err) {
      this.updateStatus("error", (err as Error).message);
      throw new Error(`Speech transcription failed: ${(err as Error).message}`);
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
