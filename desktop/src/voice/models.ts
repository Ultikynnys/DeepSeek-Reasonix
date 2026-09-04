/**
 * Voice processing model registry and cache helpers.
 */

export type VoiceModelId = "whisper-tiny.en" | "Xenova/whisper-base.en" | "Xenova/whisper-small.en";

export interface VoiceModelOption {
  id: VoiceModelId;
  name: string;
  shortName: string;
  size: string;
  parameters: string;
  description: string;
  repoId: string;
}

export const DEFAULT_VOICE_MODEL_ID: VoiceModelId = "whisper-tiny.en";

export const VOICE_MODELS: ReadonlyArray<VoiceModelOption> = [
  {
    id: "whisper-tiny.en",
    name: "Whisper Tiny (English)",
    shortName: "Tiny",
    size: "~40 MB",
    parameters: "39M",
    description: "Fastest transcription with lowest resource usage.",
    repoId: "onnx-community/whisper-tiny.en",
  },
  {
    id: "Xenova/whisper-base.en",
    name: "Whisper Base (English)",
    shortName: "Base",
    size: "~75 MB",
    parameters: "74M",
    description: "Noticeably higher accuracy for daily speech with moderate speed.",
    repoId: "onnx-community/whisper-base.en",
  },
  {
    id: "Xenova/whisper-small.en",
    name: "Whisper Small (English)",
    shortName: "Small",
    size: "~250 MB",
    parameters: "244M",
    description: "High accuracy speech recognition for accents, jargon, and noisy audio.",
    repoId: "onnx-community/whisper-small.en",
  },
];

const STORAGE_KEY_ACTIVE = "reasonix.voiceModel";
const STORAGE_PREFIX_DOWNLOADED = "reasonix.voiceModel.downloaded.";

export function getVoiceModelOption(id: string): VoiceModelOption {
  const found = VOICE_MODELS.find((m) => m.id === id);
  return found ?? VOICE_MODELS[0]!;
}

export function getActiveVoiceModelId(): VoiceModelId {
  if (typeof localStorage === "undefined") {
    return DEFAULT_VOICE_MODEL_ID;
  }
  const stored = localStorage.getItem(STORAGE_KEY_ACTIVE);
  if (stored && VOICE_MODELS.some((m) => m.id === stored)) {
    return stored as VoiceModelId;
  }
  return DEFAULT_VOICE_MODEL_ID;
}

export function setActiveVoiceModelId(id: VoiceModelId): void {
  if (typeof localStorage === "undefined") return;
  localStorage.setItem(STORAGE_KEY_ACTIVE, id);
}

export function markVoiceModelDownloaded(id: VoiceModelId, downloaded = true): void {
  if (typeof localStorage === "undefined") return;
  const key = `${STORAGE_PREFIX_DOWNLOADED}${id}`;
  if (downloaded) {
    localStorage.setItem(key, "true");
  } else {
    localStorage.removeItem(key);
  }
}

export async function isVoiceModelDownloaded(id: VoiceModelId): Promise<boolean> {
  const opt = getVoiceModelOption(id);

  // Check Web Cache API if available:
  if (typeof caches !== "undefined") {
    try {
      const cache = await caches.open("transformers-cache");
      const keys = await cache.keys();
      const hasEncoder = keys.some(
        (req) =>
          (req.url.includes(opt.repoId) || req.url.includes(opt.id)) &&
          req.url.includes("encoder_model"),
      );
      const hasDecoder = keys.some(
        (req) =>
          (req.url.includes(opt.repoId) || req.url.includes(opt.id)) &&
          req.url.includes("decoder_model"),
      );
      if (hasEncoder && hasDecoder) {
        markVoiceModelDownloaded(id, true);
        return true;
      }
    } catch {
      // Ignore cache API errors and fallback to localStorage flag.
    }
  }

  if (typeof localStorage !== "undefined") {
    return localStorage.getItem(`${STORAGE_PREFIX_DOWNLOADED}${id}`) === "true";
  }

  return false;
}

/** True when at least one voice model is present in the local cache. */
export async function anyVoiceModelDownloaded(): Promise<boolean> {
  for (const m of VOICE_MODELS) {
    if (await isVoiceModelDownloaded(m.id)) return true;
  }
  return false;
}

export async function deleteVoiceModelCache(id: VoiceModelId): Promise<void> {
  const opt = getVoiceModelOption(id);

  markVoiceModelDownloaded(id, false);

  if (typeof caches !== "undefined") {
    try {
      const cache = await caches.open("transformers-cache");
      const keys = await cache.keys();
      for (const req of keys) {
        if (req.url.includes(opt.repoId) || req.url.includes(opt.id)) {
          await cache.delete(req);
        }
      }
    } catch (e) {
      console.warn("Failed to delete voice model cache:", e);
    }
  }

  // If the deleted model was active, switch back to default bundled model:
  if (getActiveVoiceModelId() === id) {
    setActiveVoiceModelId(DEFAULT_VOICE_MODEL_ID);
  }
}
