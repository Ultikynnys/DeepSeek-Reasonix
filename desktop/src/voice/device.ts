/**
 * Audio input device enumeration and selection persistence.
 *
 * The selected device id is stored in localStorage (matching the voice-model
 * pattern in `models.ts`) so the choice survives restarts without needing the
 * daemon config round-trip. The composer reads it when starting a recording.
 */

export interface AudioInputDevice {
  deviceId: string;
  label: string;
}

const STORAGE_KEY_DEVICE = "reasonix.voiceInputDevice";

/** The stored audio input device id, or "" when the OS/browser default is used. */
export function getSelectedAudioInputDeviceId(): string {
  if (typeof localStorage === "undefined") return "";
  return localStorage.getItem(STORAGE_KEY_DEVICE) ?? "";
}

/** Persist the chosen device id. Pass "" to fall back to the default device. */
export function setSelectedAudioInputDeviceId(deviceId: string): void {
  if (typeof localStorage === "undefined") return;
  if (deviceId) {
    localStorage.setItem(STORAGE_KEY_DEVICE, deviceId);
  } else {
    localStorage.removeItem(STORAGE_KEY_DEVICE);
  }
}

/**
 * Enumerates the available audio input devices.
 *
 * Browser labels are empty until the user grants microphone permission, so we
 * fall back to a stable "Microphone N" label so the picker is still usable
 * before the first recording.
 */
export async function listAudioInputDevices(): Promise<AudioInputDevice[]> {
  if (typeof navigator === "undefined" || !navigator?.mediaDevices?.enumerateDevices) {
    return [];
  }
  const devices = await navigator.mediaDevices.enumerateDevices();
  const inputs = devices.filter((d) => d.kind === "audioinput");
  let unnamed = 0;
  return inputs.map((d) => {
    const label = d.label.trim();
    if (label) {
      return { deviceId: d.deviceId, label };
    }
    unnamed += 1;
    return { deviceId: d.deviceId, label: `Microphone ${unnamed}` };
  });
}

/**
 * Whether microphone capture has already been granted for this origin.
 *
 * Uses only the Permissions API, which touches no media hardware — safe to call
 * on mount, unlike `enumerateDevices` (which surfaces connected cameras to the
 * OS media stack in WebView2). Returns false when the API is unavailable or the
 * query fails, so callers fall back to the explicit consent button.
 */
export async function hasMicrophonePermission(): Promise<boolean> {
  if (typeof navigator === "undefined" || !navigator.permissions?.query) {
    return false;
  }
  try {
    const status = await navigator.permissions.query({ name: "microphone" as PermissionName });
    return status.state === "granted";
  } catch {
    return false;
  }
}

/**
 * Requests microphone access, resolving once the user grants it.
 *
 * Triggers the OS/browser permission prompt and — crucially — unlocks real
 * device labels for subsequent `enumerateDevices` calls (before consent those
 * labels are empty). The capture stream is stopped immediately: only the grant
 * is wanted, not an open microphone.
 */
export async function requestMicrophoneAccess(): Promise<void> {
  if (typeof navigator === "undefined" || !navigator?.mediaDevices?.getUserMedia) {
    throw new Error("Microphone capture is not supported in this environment.");
  }
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (err) {
    const error = err as Error;
    if (error?.name === "NotAllowedError" || error?.name === "PermissionDeniedError") {
      throw new Error(
        "Microphone access was not allowed. Check the app and operating-system microphone permissions.",
      );
    }
    throw new Error(`Microphone access request failed: ${error?.message || String(err)}`);
  }
  for (const track of stream.getTracks()) {
    track.stop();
  }
}
