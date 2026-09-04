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
  onError?: (error: Error) => void;
  /** Preferred audio input device id (from `enumerateDevices`). Empty → OS/browser default. */
  deviceId?: string;
}

type DetailedError = Error & { constraint?: string };

function errorDetails(err: unknown): string {
  if (!(err instanceof Error)) {
    return `unknown error: ${String(err)}`;
  }
  const error = err as DetailedError;
  const details = [`name=${error.name || "Error"}`, `message=${error.message || "No message"}`];
  if (error.constraint) {
    details.push(`constraint=${error.constraint}`);
  }
  return details.join(", ");
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

const RECORDER_WORKLET_NAME = "reasonix-recorder-worklet";

const RECORDER_WORKLET_CODE = `
class ReasonixRecorderProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.bufferSize = 4096;
    this.buffer = new Float32Array(this.bufferSize);
    this.bytesWritten = 0;
    this.port.onmessage = (event) => {
      if (event.data === "flush") {
        if (this.bytesWritten > 0) {
          const remaining = this.buffer.slice(0, this.bytesWritten);
          this.port.postMessage(remaining, [remaining.buffer]);
          this.buffer = new Float32Array(this.bufferSize);
          this.bytesWritten = 0;
        }
        this.port.postMessage({ type: "flushed" });
      }
    };
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || !input[0]) {
      return true;
    }
    const channelData = input[0];
    let offset = 0;
    while (offset < channelData.length) {
      const remaining = this.bufferSize - this.bytesWritten;
      const toCopy = Math.min(remaining, channelData.length - offset);
      this.buffer.set(channelData.subarray(offset, offset + toCopy), this.bytesWritten);
      this.bytesWritten += toCopy;
      offset += toCopy;

      if (this.bytesWritten >= this.bufferSize) {
        this.port.postMessage(this.buffer, [this.buffer.buffer]);
        this.buffer = new Float32Array(this.bufferSize);
        this.bytesWritten = 0;
      }
    }
    return true;
  }
}

registerProcessor("${RECORDER_WORKLET_NAME}", ReasonixRecorderProcessor);
`;

export class AudioRecorder {
  private mediaStream: MediaStream | null = null;
  private audioContext: AudioContext | null = null;
  private workletNode: AudioWorkletNode | null = null;
  private sourceNode: MediaStreamAudioSourceNode | null = null;
  private chunks: Float32Array[] = [];
  private isRecording = false;
  private onVolumeChange?: (level: number) => void;
  private onError?: (error: Error) => void;
  private deviceId?: string;

  constructor(options?: AudioRecorderOptions) {
    this.onVolumeChange = options?.onVolumeChange;
    this.onError = options?.onError;
    this.deviceId = options?.deviceId;
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
      const audioConstraints: MediaTrackConstraints = {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      };
      // A plain (non-exact) deviceId lets the browser fall back to the default
      // device if the chosen one is no longer available.
      if (this.deviceId) {
        audioConstraints.deviceId = this.deviceId;
      }
      this.mediaStream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints });
    } catch (err) {
      const error = err as Error;
      const technicalDetails = errorDetails(err);
      if (error.name === "NotAllowedError" || error.name === "PermissionDeniedError") {
        throw new Error(
          `Microphone access was not allowed. Check the app, browser, and operating-system microphone permissions (${technicalDetails}).`,
        );
      }
      if (error.name === "NotFoundError" || error.name === "DevicesNotFoundError") {
        throw new Error(
          `No microphone matched the requested audio settings. Check that a microphone is connected and enabled (${technicalDetails}).`,
        );
      }
      if (error.name === "NotReadableError") {
        throw new Error(
          `The microphone could not be read because of a device, operating-system, browser, or page-level failure (${technicalDetails}).`,
        );
      }
      if (error.name === "OverconstrainedError") {
        throw new Error(
          `The microphone could not satisfy the requested audio constraint (${technicalDetails}).`,
        );
      }
      throw new Error(`Microphone capture request failed (${technicalDetails}).`);
    }

    try {
      const AudioContextClass =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;

      if (!AudioContextClass) {
        throw new Error("AudioContext is not supported in this environment.");
      }

      this.audioContext = new AudioContextClass();
      if (this.audioContext.state === "suspended") {
        await this.audioContext.resume();
      }

      this.chunks = [];
      this.sourceNode = this.audioContext.createMediaStreamSource(this.mediaStream);

      if (!this.audioContext.audioWorklet) {
        throw new Error("AudioWorklet is not supported in this environment.");
      }

      const workletBlob = new Blob([RECORDER_WORKLET_CODE], { type: "application/javascript" });
      const workletUrl = URL.createObjectURL(workletBlob);
      try {
        await this.audioContext.audioWorklet.addModule(workletUrl);
      } finally {
        URL.revokeObjectURL(workletUrl);
      }

      const AudioWorkletNodeClass =
        window.AudioWorkletNode ||
        (window as unknown as { webkitAudioWorkletNode?: typeof AudioWorkletNode })
          .webkitAudioWorkletNode;

      if (!AudioWorkletNodeClass) {
        throw new Error("AudioWorkletNode is not supported in this environment.");
      }

      this.workletNode = new AudioWorkletNodeClass(this.audioContext, RECORDER_WORKLET_NAME);

      this.workletNode.port.onmessage = (event: MessageEvent<Float32Array | { type?: string }>) => {
        if (!this.isRecording) return;
        const data = event.data;
        if (!(data instanceof Float32Array)) return;

        this.chunks.push(data);

        if (this.onVolumeChange) {
          let sumSquares = 0;
          for (let i = 0; i < data.length; i++) {
            const val = data[i] ?? 0;
            sumSquares += val * val;
          }
          const rms = Math.sqrt(sumSquares / data.length);
          this.onVolumeChange(Math.min(rms * 5, 1));
        }
      };

      this.sourceNode.connect(this.workletNode);
      this.workletNode.connect(this.audioContext.destination);
      this.isRecording = true;
    } catch (err) {
      this.cleanup();
      throw new Error(`Microphone audio processing setup failed (${errorDetails(err)}).`);
    }
  }

  /**
   * Stops microphone audio capture and returns 16 kHz Float32Array PCM audio.
   */
  public async stop(): Promise<AudioRecordingResult> {
    if (!this.isRecording) {
      throw new Error("AudioRecorder is not currently recording.");
    }

    this.isRecording = false;

    // Flush any pending uncommitted samples from the worklet buffer:
    if (this.workletNode) {
      await new Promise<void>((resolve) => {
        const port = this.workletNode?.port;
        if (!port) {
          resolve();
          return;
        }
        let settled = false;
        const timeoutId = setTimeout(() => {
          if (!settled) {
            settled = true;
            resolve();
          }
        }, 100);

        port.onmessage = (event: MessageEvent<Float32Array | { type?: string }>) => {
          const data = event.data;
          if (data instanceof Float32Array) {
            this.chunks.push(data);
          } else if (
            data &&
            typeof data === "object" &&
            "type" in data &&
            data.type === "flushed"
          ) {
            if (!settled) {
              settled = true;
              clearTimeout(timeoutId);
              resolve();
            }
          }
        };

        try {
          port.postMessage("flush");
        } catch {
          clearTimeout(timeoutId);
          resolve();
        }
      });
    }

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
    if (this.workletNode) {
      this.workletNode.disconnect();
      this.workletNode.port.onmessage = null;
      this.workletNode = null;
    }
    if (this.sourceNode) {
      this.sourceNode.disconnect();
      this.sourceNode = null;
    }
    if (this.audioContext && this.audioContext.state !== "closed") {
      void this.audioContext.close().catch((err: unknown) => {
        this.onError?.(new Error(`Microphone AudioContext cleanup failed (${errorDetails(err)}).`));
      });
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
