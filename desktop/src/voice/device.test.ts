// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getSelectedAudioInputDeviceId,
  getSelectedAudioInputDeviceLabel,
  hasMicrophonePermission,
  listAudioInputDevices,
  requestMicrophoneAccess,
  resolveSelectedDeviceId,
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

  it("persists the device label alongside the id and clears both on reset", () => {
    setSelectedAudioInputDeviceId("mic-123", "USB Headset");
    expect(getSelectedAudioInputDeviceLabel()).toBe("USB Headset");
    setSelectedAudioInputDeviceId("");
    expect(getSelectedAudioInputDeviceLabel()).toBe("");
  });

  describe("resolveSelectedDeviceId", () => {
    const live = [
      { deviceId: "id-x", label: "Built-in Microphone" },
      { deviceId: "id-y", label: "USB Headset" },
    ];

    it("keeps the stored id when it is still enumerated", () => {
      setSelectedAudioInputDeviceId("id-x", "Built-in Microphone");
      expect(resolveSelectedDeviceId(live)).toBe("id-x");
    });

    it("re-matches by label when the browser rotated the device id", () => {
      setSelectedAudioInputDeviceId("stale-id", "USB Headset");
      expect(resolveSelectedDeviceId(live)).toBe("id-y");
    });

    it("returns the system default when neither the id nor the label matches", () => {
      setSelectedAudioInputDeviceId("stale-id", "Gone Headset");
      expect(resolveSelectedDeviceId(live)).toBe("");
    });

    it("returns the system default when nothing was stored", () => {
      expect(resolveSelectedDeviceId(live)).toBe("");
    });
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

describe("voice/device microphone permission", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reports no permission when the Permissions API is unavailable", async () => {
    Object.defineProperty(navigator, "permissions", { value: undefined, configurable: true });
    expect(await hasMicrophonePermission()).toBe(false);
  });

  it("reflects the granted microphone permission state", async () => {
    Object.defineProperty(navigator, "permissions", {
      value: { query: vi.fn().mockResolvedValue({ state: "granted" }) },
      configurable: true,
    });
    expect(await hasMicrophonePermission()).toBe(true);
  });

  it("treats a prompt (not-yet-granted) state as no permission", async () => {
    Object.defineProperty(navigator, "permissions", {
      value: { query: vi.fn().mockResolvedValue({ state: "prompt" }) },
      configurable: true,
    });
    expect(await hasMicrophonePermission()).toBe(false);
  });

  it("requests access and immediately stops the capture tracks", async () => {
    const stop = vi.fn();
    const getUserMedia = vi.fn().mockResolvedValue({ getTracks: () => [{ stop }] });
    Object.defineProperty(navigator, "mediaDevices", {
      value: { getUserMedia },
      configurable: true,
    });

    await requestMicrophoneAccess();

    expect(getUserMedia).toHaveBeenCalledWith({ audio: true });
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("throws a friendly error when access is denied", async () => {
    Object.defineProperty(navigator, "mediaDevices", {
      value: {
        getUserMedia: vi
          .fn()
          .mockRejectedValue(Object.assign(new Error("blocked"), { name: "NotAllowedError" })),
      },
      configurable: true,
    });

    await expect(requestMicrophoneAccess()).rejects.toThrow(/not allowed/i);
  });

  it("throws when getUserMedia is unavailable", async () => {
    Object.defineProperty(navigator, "mediaDevices", { value: undefined, configurable: true });
    await expect(requestMicrophoneAccess()).rejects.toThrow(/not supported/i);
  });
});
