/**
 * Audio recording service for capturing microphone input and converting it
 * to 16 kHz mono Float32Array PCM suitable for Whisper transcription.
 */

export interface AudioRecordingResult {
  audioData: Float32Array;
  durationSeconds: number;
}

export interface AudioRecorderOptions {
  onVolumeChange?: (level: number) => void;
}

/**
 * Resamples a Float32Array PCM audio buffer from sourceSampleRate to targetSampleRate (default 16000).
 */
export function resampleAudio(
  audioData: Float32Array,
  sourceSampleRate: number,
  targetSampleRate = 16000,
): Float32Array {
  if (sourceSampleRate === targetSampleRate || audioData.length === 0) {
    return audioData;
  }
  const ratio = sourceSampleRate / targetSampleRate;
  const newLength = Math.round(audioData.length / ratio);
  const result = new Float32Array(newLength);
  for (let i = 0; i < newLength; i++) {
    const pos = i * ratio;
    const index = Math.floor(pos);
    const frac = pos - index;
    const s0 = audioData[index] ?? 0;
    const s1 = audioData[index + 1] ?? s0;
    result[i] = s0 + frac * (s1 - s0);
  }
  return result;
}

export class AudioRecorder {
  private mediaStream: MediaStream | null = null;
  private audioContext: AudioContext | null = null;
  private scriptProcessor: ScriptProcessorNode | null = null;
  private sourceNode: MediaStreamAudioSourceNode | null = null;
  private chunks: Float32Array[] = [];
  private isRecording = false;
  private onVolumeChange?: (level: number) => void;

  constructor(options?: AudioRecorderOptions) {
    this.onVolumeChange = options?.onVolumeChange;
  }

  public get recording(): boolean {
    return this.isRecording;
  }

  /**
   * Begins microphone audio capture.
   */
  public async start(): Promise<void> {
    if (this.isRecording) {
      return;
    }

    if (typeof navigator === "undefined" || !navigator?.mediaDevices?.getUserMedia) {
      throw new Error(
        "Microphone capture is not supported in this environment (getUserMedia unavailable).",
      );
    }

    try {
      this.mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
    } catch (err) {
      const error = err as Error;
      if (error.name === "NotAllowedError" || error.name === "PermissionDeniedError") {
        throw new Error("Microphone permission was denied. Please allow microphone access.");
      }
      if (error.name === "NotFoundError" || error.name === "DevicesNotFoundError") {
        throw new Error("No microphone device was found on this system.");
      }
      if (error.name === "NotReadableError") {
        throw new Error("Microphone is currently unavailable or used by another application.");
      }
      throw new Error(`Microphone initialization failed: ${error.message}`);
    }

    const AudioContextClass =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;

    if (!AudioContextClass) {
      this.cleanup();
      throw new Error("AudioContext is not supported in this environment.");
    }

    this.audioContext = new AudioContextClass();
    if (this.audioContext.state === "suspended") {
      await this.audioContext.resume();
    }

    this.chunks = [];
    this.sourceNode = this.audioContext.createMediaStreamSource(this.mediaStream);

    // 4096 buffer size gives ~90ms latency at 44.1kHz / ~250ms at 16kHz
    this.scriptProcessor = this.audioContext.createScriptProcessor(4096, 1, 1);

    this.scriptProcessor.onaudioprocess = (event: AudioProcessingEvent) => {
      if (!this.isRecording) return;
      const channelData = event.inputBuffer.getChannelData(0);
      this.chunks.push(new Float32Array(channelData));

      if (this.onVolumeChange) {
        let sumSquares = 0;
        for (let i = 0; i < channelData.length; i++) {
          const val = channelData[i] ?? 0;
          sumSquares += val * val;
        }
        const rms = Math.sqrt(sumSquares / channelData.length);
        this.onVolumeChange(Math.min(rms * 5, 1));
      }
    };

    this.sourceNode.connect(this.scriptProcessor);
    this.scriptProcessor.connect(this.audioContext.destination);
    this.isRecording = true;
  }

  /**
   * Stops microphone audio capture and returns 16 kHz Float32Array PCM audio.
   */
  public async stop(): Promise<AudioRecordingResult> {
    if (!this.isRecording) {
      throw new Error("AudioRecorder is not currently recording.");
    }

    this.isRecording = false;

    const sourceSampleRate = this.audioContext?.sampleRate ?? 16000;
    this.cleanup();

    let totalLength = 0;
    for (const chunk of this.chunks) {
      totalLength += chunk.length;
    }

    const merged = new Float32Array(totalLength);
    let offset = 0;
    for (const chunk of this.chunks) {
      merged.set(chunk, offset);
      offset += chunk.length;
    }
    this.chunks = [];

    const resampled = resampleAudio(merged, sourceSampleRate, 16000);
    const durationSeconds = resampled.length / 16000;

    return {
      audioData: resampled,
      durationSeconds,
    };
  }

  /**
   * Cancels the active recording without returning data.
   */
  public cancel(): void {
    this.isRecording = false;
    this.chunks = [];
    this.cleanup();
  }

  private cleanup(): void {
    if (this.scriptProcessor) {
      this.scriptProcessor.disconnect();
      this.scriptProcessor.onaudioprocess = null;
      this.scriptProcessor = null;
    }
    if (this.sourceNode) {
      this.sourceNode.disconnect();
      this.sourceNode = null;
    }
    if (this.audioContext && this.audioContext.state !== "closed") {
      void this.audioContext.close();
      this.audioContext = null;
    }
    if (this.mediaStream) {
      for (const track of this.mediaStream.getTracks()) {
        track.stop();
      }
      this.mediaStream = null;
    }
    if (this.onVolumeChange) {
      this.onVolumeChange(0);
    }
  }
}
