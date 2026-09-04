// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_VOICE_MODEL_ID,
  VOICE_MODELS,
  deleteVoiceModelCache,
  getActiveVoiceModelId,
  getVoiceModelOption,
  isVoiceModelDownloaded,
  markVoiceModelDownloaded,
  setActiveVoiceModelId,
} from "./models";

describe("Voice Models Registry", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("provides exactly 3 voice model options", () => {
    expect(VOICE_MODELS).toHaveLength(3);
    expect(VOICE_MODELS.map((m) => m.id)).toEqual([
      "whisper-tiny.en",
      "Xenova/whisper-base.en",
      "Xenova/whisper-small.en",
    ]);
  });

  it("defaults to the whisper-tiny.en model", () => {
    expect(DEFAULT_VOICE_MODEL_ID).toBe("whisper-tiny.en");
    expect(getActiveVoiceModelId()).toBe("whisper-tiny.en");
  });

  it("persists active voice model selection", () => {
    setActiveVoiceModelId("Xenova/whisper-base.en");
    expect(getActiveVoiceModelId()).toBe("Xenova/whisper-base.en");

    setActiveVoiceModelId("Xenova/whisper-small.en");
    expect(getActiveVoiceModelId()).toBe("Xenova/whisper-small.en");
  });

  it("looks up model options by id", () => {
    const tiny = getVoiceModelOption("whisper-tiny.en");
    expect(tiny.shortName).toBe("Tiny");

    const base = getVoiceModelOption("Xenova/whisper-base.en");
    expect(base.shortName).toBe("Base");

    const small = getVoiceModelOption("Xenova/whisper-small.en");
    expect(small.shortName).toBe("Small");

    // Fallback for unknown id
    const unknown = getVoiceModelOption("unknown-model");
    expect(unknown.id).toBe("whisper-tiny.en");
  });

  it("tracks and clears download state for remote models", async () => {
    expect(await isVoiceModelDownloaded("Xenova/whisper-base.en")).toBe(false);

    markVoiceModelDownloaded("Xenova/whisper-base.en", true);
    expect(await isVoiceModelDownloaded("Xenova/whisper-base.en")).toBe(true);

    setActiveVoiceModelId("Xenova/whisper-base.en");
    expect(getActiveVoiceModelId()).toBe("Xenova/whisper-base.en");

    await deleteVoiceModelCache("Xenova/whisper-base.en");
    expect(await isVoiceModelDownloaded("Xenova/whisper-base.en")).toBe(false);
    // Deleted active model resets to the default:
    expect(getActiveVoiceModelId()).toBe("whisper-tiny.en");
  });
});
