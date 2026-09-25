import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Jimp } from "jimp";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ToolRegistry } from "../src/tools.js";
import {
  type CaptureArea,
  type FocusResult,
  type MonitorInfo,
  calculateCaptureArea,
  registerScreenCaptureTool,
  resolveOutputPath,
  selectMonitor,
} from "../src/tools/screen-capture.js";
import { registerSeeImageTool } from "../src/tools/see-image.js";
import type { UserContentPart } from "../src/types.js";

describe("screen_capture", () => {
  let root: string;
  let mockMonitors: MonitorInfo[];
  let capturedOptions: Array<{ monitor: MonitorInfo; crop: CaptureArea; outputPath: string }>;
  let focusedApps: string[];

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "screen-capture-"));
    mockMonitors = [
      {
        id: "\\\\.\\DISPLAY1",
        name: "\\\\.\\DISPLAY1",
        index: 0,
        x: 0,
        y: 0,
        width: 1920,
        height: 1080,
        primary: true,
      },
      {
        id: "\\\\.\\DISPLAY2",
        name: "\\\\.\\DISPLAY2",
        index: 1,
        x: 1920,
        y: 0,
        width: 2560,
        height: 1440,
        primary: false,
      },
    ];
    capturedOptions = [];
    focusedApps = [];
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  async function mockPngBuffer(): Promise<Buffer> {
    const img = new Jimp({ width: 10, height: 10, color: 0xff0000ff });
    return await img.getBuffer("image/png");
  }

  function setupRegistry(
    opts: {
      includeSeeImage?: boolean;
      focusRunner?: (app: string) => Promise<FocusResult | undefined>;
    } = {},
  ): ToolRegistry {
    const registry = new ToolRegistry();
    if (opts.includeSeeImage !== false) {
      registerSeeImageTool(registry, { rootDir: root });
    }
    registerScreenCaptureTool(registry, {
      rootDir: root,
      listMonitors: async () => mockMonitors,
      focusRunner:
        opts.focusRunner ??
        (async (app) => {
          focusedApps.push(app);
          return undefined;
        }),
      captureRunner: async (opt) => {
        capturedOptions.push(opt);
        const buf = await mockPngBuffer();
        writeFileSync(opt.outputPath, buf);
      },
    });
    return registry;
  }

  it("registers tool with correct name and schema", () => {
    const reg = setupRegistry();
    expect(reg.has("screen_capture")).toBe(true);
    const def = reg.get("screen_capture");
    expect(def).toBeDefined();
    expect(def?.name).toBe("screen_capture");
    const props = (def?.parameters as { properties: Record<string, unknown> }).properties;
    expect(props).toHaveProperty("app");
    expect(props).toHaveProperty("monitor");
    expect(props).toHaveProperty("top_left_x");
    expect(props).toHaveProperty("top_left_y");
    expect(props).toHaveProperty("bottom_right_x");
    expect(props).toHaveProperty("bottom_right_y");
  });

  it("captures full primary monitor by default and directly feeds to see_image", async () => {
    const reg = setupRegistry();
    const result = await reg.dispatch("screen_capture", "{}", { rootDir: root });

    expect(Array.isArray(result)).toBe(true);
    const parts = result as UserContentPart[];
    const textPart = parts.find((p) => p.type === "text") as { text: string } | undefined;
    expect(textPart?.text).toContain("Screen capture (monitor 0 [\\\\.\\DISPLAY1]");
    expect(textPart?.text).toContain("Image loaded at");
    const imagePart = parts.find((p) => p.type === "image_url") as
      | { image_url: { url: string } }
      | undefined;
    expect(imagePart?.image_url.url.startsWith("data:image/png;base64,")).toBe(true);

    expect(capturedOptions).toHaveLength(1);
    expect(capturedOptions[0]?.monitor.index).toBe(0);
    expect(capturedOptions[0]?.crop.width).toBe(1920);
    expect(capturedOptions[0]?.crop.height).toBe(1080);
  });

  it("captures a specific monitor by index", async () => {
    const reg = setupRegistry();
    const result = await reg.dispatch("screen_capture", JSON.stringify({ monitor: 1 }), {
      rootDir: root,
    });

    expect(Array.isArray(result)).toBe(true);
    expect(capturedOptions).toHaveLength(1);
    expect(capturedOptions[0]?.monitor.index).toBe(1);
    expect(capturedOptions[0]?.crop.width).toBe(2560);
    expect(capturedOptions[0]?.crop.height).toBe(1440);
    expect(capturedOptions[0]?.crop.globalX).toBe(1920);
  });

  it("captures a specific rectangular region using top_left and bottom_right parameters", async () => {
    const reg = setupRegistry();
    const result = await reg.dispatch(
      "screen_capture",
      JSON.stringify({
        monitor: 0,
        top_left_x: 100,
        top_left_y: 150,
        bottom_right_x: 500,
        bottom_right_y: 450,
      }),
      { rootDir: root },
    );

    expect(Array.isArray(result)).toBe(true);
    expect(capturedOptions).toHaveLength(1);
    const opt = capturedOptions[0]!;
    expect(opt.crop.x).toBe(100);
    expect(opt.crop.y).toBe(150);
    expect(opt.crop.width).toBe(400);
    expect(opt.crop.height).toBe(300);
    expect(opt.crop.globalX).toBe(100);
    expect(opt.crop.globalY).toBe(150);
  });

  it("normalizes inverted corner coordinates", async () => {
    const reg = setupRegistry();
    const result = await reg.dispatch(
      "screen_capture",
      JSON.stringify({
        monitor: 0,
        top_left_x: 500,
        top_left_y: 450,
        bottom_right_x: 100,
        bottom_right_y: 150,
      }),
      { rootDir: root },
    );

    expect(Array.isArray(result)).toBe(true);
    expect(capturedOptions).toHaveLength(1);
    const opt = capturedOptions[0]!;
    expect(opt.crop.x).toBe(100);
    expect(opt.crop.y).toBe(150);
    expect(opt.crop.width).toBe(400);
    expect(opt.crop.height).toBe(300);
  });

  it("supports array pair coordinates [x, y]", async () => {
    const reg = setupRegistry();
    const result = await reg.dispatch(
      "screen_capture",
      JSON.stringify({
        monitor: 1,
        top_left: [200, 250],
        bottom_right: [600, 650],
      }),
      { rootDir: root },
    );

    expect(Array.isArray(result)).toBe(true);
    expect(capturedOptions).toHaveLength(1);
    const opt = capturedOptions[0]!;
    expect(opt.monitor.index).toBe(1);
    expect(opt.crop.x).toBe(200);
    expect(opt.crop.y).toBe(250);
    expect(opt.crop.width).toBe(400);
    expect(opt.crop.height).toBe(400);
    expect(opt.crop.globalX).toBe(1920 + 200);
  });

  it("fails fast with loud error on invalid monitor selection", async () => {
    const reg = setupRegistry();
    const result = await reg.dispatch("screen_capture", JSON.stringify({ monitor: 99 }), {
      rootDir: root,
    });

    expect(typeof result).toBe("string");
    expect(result).toContain("screen_capture: invalid monitor '99'");
    expect(result).toContain("Available monitors");
  });

  it("fails fast with loud error when only one corner is provided", async () => {
    const reg = setupRegistry();
    const result = await reg.dispatch(
      "screen_capture",
      JSON.stringify({ top_left_x: 100, top_left_y: 100 }),
      { rootDir: root },
    );

    expect(typeof result).toBe("string");
    expect(result).toContain("both top-left and bottom-right corners must be specified");
  });

  it("fails fast with loud error on zero area crop region", async () => {
    const reg = setupRegistry();
    const result = await reg.dispatch(
      "screen_capture",
      JSON.stringify({
        top_left_x: 100,
        top_left_y: 100,
        bottom_right_x: 100,
        bottom_right_y: 100,
      }),
      { rootDir: root },
    );

    expect(typeof result).toBe("string");
    expect(result).toContain("invalid capture region: width and height must be positive");
  });

  it("fails fast with loud error when region is entirely outside monitor bounds", async () => {
    const reg = setupRegistry();
    const result = await reg.dispatch(
      "screen_capture",
      JSON.stringify({
        monitor: 0,
        top_left_x: 2000,
        top_left_y: 2000,
        bottom_right_x: 2500,
        bottom_right_y: 2500,
      }),
      { rootDir: root },
    );

    expect(typeof result).toBe("string");
    expect(result).toContain("is outside monitor bounds (1920x1080)");
  });

  it("fails loud if see_image tool is not registered", async () => {
    const reg = setupRegistry({ includeSeeImage: false });
    const result = await reg.dispatch("screen_capture", "{}", { rootDir: root });

    expect(typeof result).toBe("string");
    expect(result).toContain("see_image tool is not registered");
  });

  it("saves screenshot to custom path when provided", async () => {
    const reg = setupRegistry();
    const customDest = join(root, "custom-shot.png");
    const result = await reg.dispatch("screen_capture", JSON.stringify({ path: customDest }), {
      rootDir: root,
    });

    expect(Array.isArray(result)).toBe(true);
    expect(capturedOptions).toHaveLength(1);
    expect(capturedOptions[0]?.outputPath).toBe(customDest);
  });

  it("brings specified app to foreground before capture and records in metadata", async () => {
    const reg = setupRegistry();
    const result = await reg.dispatch("screen_capture", JSON.stringify({ app: "Blender" }), {
      rootDir: root,
    });

    expect(Array.isArray(result)).toBe(true);
    expect(focusedApps).toEqual(["Blender"]);
    const textPart = (result as UserContentPart[]).find((p) => p.type === "text") as
      | { text: string }
      | undefined;
    expect(textPart?.text).toContain('app "Blender"');
    expect(capturedOptions).toHaveLength(1);
  });

  it("follows the focused app's monitor instead of the primary when no monitor is given", async () => {
    const reg = setupRegistry({
      focusRunner: async () => ({ monitorName: mockMonitors[1]!.name }),
    });

    const result = await reg.dispatch("screen_capture", JSON.stringify({ app: "Blender" }), {
      rootDir: root,
    });

    expect(Array.isArray(result)).toBe(true);
    expect(capturedOptions).toHaveLength(1);
    expect(capturedOptions[0]?.monitor.index).toBe(1);
    expect(capturedOptions[0]?.crop.width).toBe(2560);
  });

  it("lets an explicit monitor override the focused app's monitor", async () => {
    const reg = setupRegistry({
      focusRunner: async () => ({ monitorName: mockMonitors[1]!.name }),
    });

    await reg.dispatch("screen_capture", JSON.stringify({ app: "Blender", monitor: 0 }), {
      rootDir: root,
    });

    expect(capturedOptions[0]?.monitor.index).toBe(0);
  });

  it("falls back to the primary monitor when the app's monitor cannot be resolved", async () => {
    const reg = setupRegistry({
      focusRunner: async () => ({ monitorName: "NO_SUCH_DISPLAY" }),
    });

    const result = await reg.dispatch("screen_capture", JSON.stringify({ app: "Blender" }), {
      rootDir: root,
    });

    expect(Array.isArray(result)).toBe(true);
    expect(capturedOptions[0]?.monitor.index).toBe(0);
  });

  it("supports window and window_title aliases for focusing", async () => {
    const reg = setupRegistry();
    await reg.dispatch("screen_capture", JSON.stringify({ window: "UnrealEditor" }), {
      rootDir: root,
    });
    expect(focusedApps).toContain("UnrealEditor");

    await reg.dispatch("screen_capture", JSON.stringify({ window_title: "Obsidian" }), {
      rootDir: root,
    });
    expect(focusedApps).toContain("Obsidian");
  });

  it("fails fast and loud without capturing if app is not found", async () => {
    const reg = setupRegistry({
      focusRunner: async (app) => {
        throw new Error(
          `screen_capture: no running application or window matching '${app}' found.`,
        );
      },
    });

    const result = await reg.dispatch("screen_capture", JSON.stringify({ app: "MissingApp" }), {
      rootDir: root,
    });

    expect(typeof result).toBe("string");
    expect(result).toContain("no running application or window matching 'MissingApp' found");
    // Ensure capture was aborted and never ran
    expect(capturedOptions).toHaveLength(0);
  });

  it("fails fast with loud error on non-numeric coordinate values", async () => {
    const reg = setupRegistry();
    const result = await reg.dispatch(
      "screen_capture",
      JSON.stringify({
        top_left_x: "not-a-number",
        top_left_y: 100,
        bottom_right_x: 200,
        bottom_right_y: 200,
      }),
      { rootDir: root },
    );

    expect(typeof result).toBe("string");
    expect(result).toContain("parameter 'top_left_x' must be a valid number");
  });

  it("pure calculateCaptureArea computes coordinates, clamps bounds, and validates area", () => {
    const monitor: MonitorInfo = {
      id: "M0",
      name: "M0",
      index: 0,
      x: 100,
      y: 100,
      width: 1920,
      height: 1080,
      primary: true,
    };

    // Full monitor when no corners specified
    const full = calculateCaptureArea(monitor);
    expect(full).toEqual({
      x: 0,
      y: 0,
      width: 1920,
      height: 1080,
      globalX: 100,
      globalY: 100,
    });

    // Sub-region with partial clamping
    const clamped = calculateCaptureArea(monitor, { x: 1800, y: 1000 }, { x: 2100, y: 1200 });
    expect(clamped.x).toBe(1800);
    expect(clamped.y).toBe(1000);
    expect(clamped.width).toBe(120); // 1920 - 1800
    expect(clamped.height).toBe(80); // 1080 - 1000
    expect(clamped.globalX).toBe(1900);
    expect(clamped.globalY).toBe(1100);

    // Completely out-of-bounds throws
    expect(() => calculateCaptureArea(monitor, { x: 2000, y: 2000 }, { x: 2100, y: 2100 })).toThrow(
      "outside monitor bounds",
    );

    // Zero area throws
    expect(() => calculateCaptureArea(monitor, { x: 50, y: 50 }, { x: 50, y: 100 })).toThrow(
      "must be positive",
    );
  });

  it("pure selectMonitor selects primary, by index, or by name and lists available on failure", () => {
    // Default primary
    const primary = selectMonitor(mockMonitors, undefined);
    expect(primary.index).toBe(0);

    // By index
    const m1 = selectMonitor(mockMonitors, 1);
    expect(m1.index).toBe(1);

    // By name
    const mName = selectMonitor(mockMonitors, "\\\\.\\DISPLAY2");
    expect(mName.index).toBe(1);

    // Unknown monitor throws with available list
    expect(() => selectMonitor(mockMonitors, "MISSING_DISPLAY")).toThrow("Available monitors: #0:");
  });

  it("pure resolveOutputPath produces project-rooted screenshots and cleans up old captures", () => {
    const out1 = resolveOutputPath(undefined, root);
    expect(out1.startsWith(join(root, ".reasonix", "screenshots"))).toBe(true);

    const custom = resolveOutputPath("my-capture.png", root);
    expect(custom).toBe(join(root, "my-capture.png"));
  });

  it.runIf(process.platform === "win32")(
    "performs real capture on Windows host and feeds to see_image",
    async () => {
      const registry = new ToolRegistry();
      registerSeeImageTool(registry, { rootDir: root });
      registerScreenCaptureTool(registry, { rootDir: root });

      const result = await registry.dispatch(
        "screen_capture",
        JSON.stringify({
          top_left_x: 0,
          top_left_y: 0,
          bottom_right_x: 50,
          bottom_right_y: 50,
        }),
        { rootDir: root },
      );

      expect(Array.isArray(result)).toBe(true);
      const parts = result as UserContentPart[];
      expect(parts.some((p) => p.type === "image_url")).toBe(true);
    },
    // Real PowerShell capture (monitor query + Add-Type C# compile + screen
    // copy) can exceed the 5s default on a cold CI runner.
    30000,
  );

  it.runIf(process.platform === "win32")(
    "real Windows host app focus succeeds on existing app and fails loud on missing app",
    async () => {
      const registry = new ToolRegistry();
      registerSeeImageTool(registry, { rootDir: root });
      registerScreenCaptureTool(registry, { rootDir: root });

      // Real focus on running explorer process
      const okResult = await registry.dispatch(
        "screen_capture",
        JSON.stringify({
          app: "explorer",
          top_left_x: 0,
          top_left_y: 0,
          bottom_right_x: 50,
          bottom_right_y: 50,
        }),
        { rootDir: root },
      );
      expect(Array.isArray(okResult)).toBe(true);

      // Real focus on non-existent app fails loud
      const failResult = await registry.dispatch(
        "screen_capture",
        JSON.stringify({ app: "CompletelyFakeNonExistentApp12345" }),
        { rootDir: root },
      );
      expect(typeof failResult).toBe("string");
      expect((failResult as string).toLowerCase()).toContain(
        "no running application or window matching 'completelyfakenonexistentapp12345' found",
      );
    },
    20000,
  );
});
