// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getSelectedAudioInputDeviceId,
  listAudioInputDevices,
  setSelectedAudioInputDeviceId,
} from "../voice/device";

describe("voice/device", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("defaults to the system device when nothing is stored", () => {
    expect(getSelectedAudioInputDeviceId()).toBe("");
  });

  it("persists and reads back the selected device id", () => {
    setSelectedAudioInputDeviceId("mic-123");
    expect(getSelectedAudioInputDeviceId()).toBe("mic-123");
    expect(localStorage.getItem("reasonix.voiceInputDevice")).toBe("mic-123");
  });

  it("clears the stored device when reset to default", () => {
    setSelectedAudioInputDeviceId("mic-123");
    setSelectedAudioInputDeviceId("");
    expect(getSelectedAudioInputDeviceId()).toBe("");
    expect(localStorage.getItem("reasonix.voiceInputDevice")).toBeNull();
  });

  it("returns an empty list when enumerateDevices is unavailable", async () => {
    Object.defineProperty(navigator, "mediaDevices", {
      value: undefined,
      configurable: true,
    });
    expect(await listAudioInputDevices()).toEqual([]);
  });

  it("lists only audio input devices with labels", async () => {
    Object.defineProperty(navigator, "mediaDevices", {
      value: {
        enumerateDevices: vi.fn().mockResolvedValue([
          { kind: "audioinput", deviceId: "a1", label: "Built-in Microphone" },
          { kind: "audioinput", deviceId: "a2", label: "" },
          { kind: "audiooutput", deviceId: "o1", label: "Speakers" },
        ]),
      },
      configurable: true,
    });

    const devices = await listAudioInputDevices();
    expect(devices).toEqual([
      { deviceId: "a1", label: "Built-in Microphone" },
      { deviceId: "a2", label: "Microphone 1" },
    ]);
  });
});
