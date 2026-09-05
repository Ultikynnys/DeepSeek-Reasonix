import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  OPENCODE_MODELS_CACHE_TTL_MS,
  fetchOpencodeModels,
  isDiscoveredOpencodeModel,
  loadOpencodeModelsCache,
  opencodeModelsCachePath,
  writeOpencodeModelsCache,
} from "../src/opencode-models.js";

const TEST_DIR = join(process.cwd(), ".tmp-test-opencode-models");

describe("opencode-models", () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("extracts free models and vision models from models.dev response", async () => {
    const fakeData = {
      opencode: {
        models: {
          "new-free-model": {
            id: "new-free-model",
            name: "New Free Model",
            attachment: true,
            cost: { input: 0, output: 0 },
          },
          "paid-model": {
            id: "paid-model",
            name: "Paid Model",
            attachment: false,
            cost: { input: 1.5, output: 2.0 },
          },
        },
      },
    };

    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify(fakeData), { status: 200 }));

    const snapshot = await fetchOpencodeModels({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      homeDir: TEST_DIR,
      force: true,
    });

    expect(snapshot.error).toBeUndefined();
    expect(snapshot.models).toContain("new-free-model");
    expect(snapshot.visionModels).toContain("new-free-model");
    expect(snapshot.models).not.toContain("paid-model");
    // Also contains static baseline models
    expect(snapshot.models).toContain("big-pickle");
  });

  it("serves from cache when within TTL and force is false", async () => {
    writeOpencodeModelsCache(
      {
        models: ["cached-model"],
        visionModels: ["cached-model"],
        checkedAt: Date.now() - 1000,
      },
      TEST_DIR,
    );

    const fetchImpl = vi.fn();
    const snapshot = await fetchOpencodeModels({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      homeDir: TEST_DIR,
      force: false,
    });

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(snapshot.models).toEqual(["cached-model"]);
  });

  it("bypasses cache when force is true", async () => {
    writeOpencodeModelsCache(
      {
        models: ["old-cached-model"],
        visionModels: [],
        checkedAt: Date.now() - 1000,
      },
      TEST_DIR,
    );

    const fakeData = {
      opencode: {
        models: {
          "refreshed-free-model": {
            id: "refreshed-free-model",
            cost: { input: 0, output: 0 },
          },
        },
      },
    };

    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify(fakeData), { status: 200 }));

    const snapshot = await fetchOpencodeModels({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      homeDir: TEST_DIR,
      force: true,
    });

    expect(fetchImpl).toHaveBeenCalled();
    expect(snapshot.models).toContain("refreshed-free-model");
  });

  it("logs loudly to stderr on fetch failure and reports error in snapshot (AntiSilentFallback)", async () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const fetchImpl = vi.fn().mockRejectedValue(new Error("Network unreachable"));

    const snapshot = await fetchOpencodeModels({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      homeDir: TEST_DIR,
      force: true,
    });

    expect(stderrSpy).toHaveBeenCalled();
    const logged = stderrSpy.mock.calls.map((c) => String(c[0])).join("");
    expect(logged).toContain("reasonix: failed to fetch models.dev");
    expect(snapshot.error).toContain("Network unreachable");
    // Still includes baseline models
    expect(snapshot.models).toContain("big-pickle");
  });

  it("isDiscoveredOpencodeModel checks static catalog and cached discovery", () => {
    expect(isDiscoveredOpencodeModel("big-pickle", TEST_DIR)).toBe(true);
    expect(isDiscoveredOpencodeModel("unknown-model", TEST_DIR)).toBe(false);

    writeOpencodeModelsCache(
      {
        models: ["custom-discovered-model"],
        visionModels: [],
        checkedAt: Date.now(),
      },
      TEST_DIR,
    );

    expect(isDiscoveredOpencodeModel("custom-discovered-model", TEST_DIR)).toBe(true);
  });
});
