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
