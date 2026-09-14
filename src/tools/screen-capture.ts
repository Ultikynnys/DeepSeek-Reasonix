/** screen_capture: captures screen or rectangular region from a chosen monitor
 *  and directly feeds the capture to the see_image tool for vision analysis. */

import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import type { ToolCallContext, ToolRegistry } from "../tools.js";
import type { UserContentPart } from "../types.js";

const execFileAsync = promisify(execFile);

export interface MonitorInfo {
  id: string;
  name: string;
  index: number;
  x: number;
  y: number;
  width: number;
  height: number;
  primary: boolean;
}

export interface CaptureArea {
  x: number;
  y: number;
  width: number;
  height: number;
  globalX: number;
  globalY: number;
}

export interface ScreenCaptureToolOptions {
  /** Project root for resolving relative paths. Defaults to ctx.rootDir. */
  rootDir?: string;
  /** Optional custom capture runner (useful for mocking in tests). */
  captureRunner?: (options: {
    monitor: MonitorInfo;
    crop: CaptureArea;
    outputPath: string;
  }) => Promise<void>;
  /** Optional custom focus runner (useful for mocking in tests). */
  focusRunner?: (app: string) => Promise<void>;
  /** Optional custom monitor lister (useful for mocking in tests). */
  listMonitors?: () => Promise<MonitorInfo[]>;
}

const DESCRIPTION =
  "Capture a screenshot from a chosen monitor with optional top-left and bottom-right corner crop coordinates. Supports bringing a specific application or window to the foreground before capture via `app`. Directly feeds the captured image to see_image so vision models can inspect it immediately. Specify `monitor` by index (0 for primary/first monitor) or display name. Specify `top_left_x`, `top_left_y`, `bottom_right_x`, `bottom_right_y` to capture a specific rectangular region (in pixels relative to the monitor's top-left corner), or omit them to capture the entire monitor.";

/** Common DPI-awareness preamble for Windows PowerShell operations. */
const WIN_DPI_PREAMBLE = [
  "$dpiCode = 'using System.Runtime.InteropServices; public class ScreenDpi { [DllImport(\"user32.dll\")] public static extern bool SetProcessDPIAware(); }';",
  "Add-Type -TypeDefinition $dpiCode -ErrorAction SilentlyContinue;",
  "[ScreenDpi]::SetProcessDPIAware() | Out-Null;",
].join(" ");

/** Execute a PowerShell script with strict error handling, UTF-8 encoding, and timeout. */
async function runPowerShell(script: string, timeout = 20000): Promise<string> {
  const fullScript = [
    "$ErrorActionPreference = 'Stop';",
    "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8;",
    script,
  ].join("\n");

  const { stdout } = await execFileAsync(
    "powershell",
    ["-NoProfile", "-NonInteractive", "-Command", fullScript],
    { timeout },
  );
  return stdout;
}

/** Query connected monitors on Windows using PowerShell and System.Windows.Forms. */
async function listMonitorsWindows(): Promise<MonitorInfo[]> {
  const script = [
    WIN_DPI_PREAMBLE,
    "Add-Type -AssemblyName System.Windows.Forms;",
    "$screens = [System.Windows.Forms.Screen]::AllScreens;",
    "$screens | ForEach-Object { Write-Output ($_.DeviceName + '|' + $_.Bounds.X + '|' + $_.Bounds.Y + '|' + $_.Bounds.Width + '|' + $_.Bounds.Height + '|' + $_.Primary) }",
  ].join("\n");

  const stdout = await runPowerShell(script, 10000);

  const lines = stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && l.includes("|"));

  const monitors: MonitorInfo[] = [];
  let index = 0;
  for (const line of lines) {
    const parts = line.split("|");
    if (parts.length >= 6) {
      const name = parts[0] ?? `DISPLAY${index + 1}`;
      const x = Number.parseInt(parts[1] ?? "0", 10);
      const y = Number.parseInt(parts[2] ?? "0", 10);
      const width = Number.parseInt(parts[3] ?? "1920", 10);
      const height = Number.parseInt(parts[4] ?? "1080", 10);
      const primary = (parts[5] ?? "").toLowerCase() === "true";
      monitors.push({
        id: name,
        name,
        index,
        x,
        y,
        width,
        height,
        primary,
      });
      index++;
    }
  }

  if (monitors.length === 0) {
    throw new Error("screen_capture: no active displays detected on Windows.");
  }

  return monitors;
}

/** Query connected monitors on macOS using system_profiler SPDisplaysDataType. */
async function listMonitorsDarwin(): Promise<MonitorInfo[]> {
  let stdout = "";
  try {
    const res = await execFileAsync("system_profiler", ["SPDisplaysDataType"], { timeout: 10000 });
    stdout = res.stdout;
  } catch (err) {
    throw new Error(
      `screen_capture: failed to query displays on macOS: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const monitors: MonitorInfo[] = [];
  const displayMatches = stdout.match(/Resolution:\s*(\d+)\s*x\s*(\d+)/gi);
  if (displayMatches && displayMatches.length > 0) {
    for (let i = 0; i < displayMatches.length; i++) {
      const match = /(\d+)\s*x\s*(\d+)/.exec(displayMatches[i] ?? "");
      if (match) {
        const width = Number.parseInt(match[1] ?? "1920", 10);
        const height = Number.parseInt(match[2] ?? "1080", 10);
        monitors.push({
          id: `Display-${i}`,
          name: `Display ${i}`,
          index: i,
          x: 0,
          y: 0,
          width,
          height,
          primary: i === 0,
        });
      }
    }
  }

  if (monitors.length === 0) {
    throw new Error("screen_capture: could not parse display geometry from system_profiler.");
  }

  return monitors;
}

/** Query connected monitors on Linux using xrandr. */
async function listMonitorsLinux(): Promise<MonitorInfo[]> {
  let stdout = "";
  try {
    const res = await execFileAsync("xrandr", [], { timeout: 10000 });
    stdout = res.stdout;
  } catch (err) {
    throw new Error(
      `screen_capture: xrandr command failed: ${err instanceof Error ? err.message : String(err)}. Ensure xrandr is installed and display server is active.`,
    );
  }

  const lines = stdout.split(/\r?\n/);
  const monitors: MonitorInfo[] = [];
  let index = 0;
  for (const line of lines) {
    if (line.includes(" connected ")) {
      const match = /(\S+)\s+connected\s+(?:primary\s+)?(\d+)x(\d+)\+(\d+)\+(\d+)/.exec(line);
      if (match) {
        const name = match[1] ?? `Screen-${index}`;
        const width = Number.parseInt(match[2] ?? "1920", 10);
        const height = Number.parseInt(match[3] ?? "1080", 10);
        const x = Number.parseInt(match[4] ?? "0", 10);
        const y = Number.parseInt(match[5] ?? "0", 10);
        const primary = line.includes("primary");
        monitors.push({
          id: name,
          name,
          index,
          x,
          y,
          width,
          height,
          primary,
        });
        index++;
      }
    }
  }

  if (monitors.length === 0) {
    throw new Error("screen_capture: no connected displays found in xrandr output.");
  }

  return monitors;
}

/** Get list of monitors for the current platform. */
export async function defaultListMonitors(): Promise<MonitorInfo[]> {
  switch (process.platform) {
    case "win32":
      return listMonitorsWindows();
    case "darwin":
      return listMonitorsDarwin();
    default:
      return listMonitorsLinux();
  }
}

/** Execute native screen capture on Windows via PowerShell. */
async function captureWindows(crop: CaptureArea, outputPath: string): Promise<void> {
  const sanitizedPath = outputPath.replace(/'/g, "''");
  const script = [
    WIN_DPI_PREAMBLE,
    "Add-Type -AssemblyName System.Windows.Forms;",
    "Add-Type -AssemblyName System.Drawing;",
    `$bmp = New-Object System.Drawing.Bitmap(${crop.width}, ${crop.height});`,
    "$g = [System.Drawing.Graphics]::FromImage($bmp);",
    "try {",
    `    $g.CopyFromScreen(${crop.globalX}, ${crop.globalY}, 0, 0, (New-Object System.Drawing.Size(${crop.width}, ${crop.height})));`,
    `    $bmp.Save('${sanitizedPath}', [System.Drawing.Imaging.ImageFormat]::Png);`,
    "} finally {",
    "    $g.Dispose();",
    "    $bmp.Dispose();",
    "}",
  ].join("\n");

  await runPowerShell(script, 30000);
}

/** Execute native screen capture on macOS using screencapture. */
async function captureDarwin(
  monitor: MonitorInfo,
  crop: CaptureArea,
  outputPath: string,
): Promise<void> {
  const isCropped = crop.width !== monitor.width || crop.height !== monitor.height;
  const args = isCropped
    ? ["-x", `-R${crop.globalX},${crop.globalY},${crop.width},${crop.height}`, outputPath]
    : ["-x", "-D", String(monitor.index + 1), outputPath];

  await execFileAsync("screencapture", args, { timeout: 30000 });
}

/** Execute screen capture on Linux using available CLI tools. */
async function captureLinux(crop: CaptureArea, outputPath: string): Promise<void> {
  // 1. Try maim
  try {
    const geom = `${crop.width}x${crop.height}+${crop.globalX}+${crop.globalY}`;
    await execFileAsync("maim", ["-g", geom, outputPath], { timeout: 15000 });
    return;
  } catch {
    // Continue to next candidate
  }

  // 2. Try ImageMagick import
  try {
    const cropArg = `${crop.width}x${crop.height}+${crop.globalX}+${crop.globalY}`;
    await execFileAsync("import", ["-silent", "-window", "root", "-crop", cropArg, outputPath], {
      timeout: 15000,
    });
    return;
  } catch {
    // Continue to next candidate
  }

  // 3. Try scrot
  try {
    await execFileAsync(
      "scrot",
      ["-a", `${crop.globalX},${crop.globalY},${crop.width},${crop.height}`, outputPath],
      { timeout: 15000 },
    );
    return;
  } catch {
    throw new Error(
      "screen_capture: no supported screen capture tool found on Linux. Install maim, imagemagick, or scrot.",
    );
  }
}

/** Default screen capture dispatcher by platform. */
export async function defaultCaptureRunner(options: {
  monitor: MonitorInfo;
  crop: CaptureArea;
  outputPath: string;
}): Promise<void> {
  switch (process.platform) {
    case "win32":
      await captureWindows(options.crop, options.outputPath);
      break;
    case "darwin":
      await captureDarwin(options.monitor, options.crop, options.outputPath);
      break;
    default:
      await captureLinux(options.crop, options.outputPath);
      break;
  }

  if (!existsSync(options.outputPath) || statSync(options.outputPath).size === 0) {
    throw new Error(
      `screen_capture: capture completed but output file is missing or empty: ${options.outputPath}`,
    );
  }
}

/** Bring an application/window to the foreground on Windows via PowerShell and Win32. */
async function focusAppWindows(appQuery: string): Promise<void> {
  const sanitized = appQuery.replace(/'/g, "''");
  const script = [
    `$query = '${sanitized}';`,
    '$code = \'using System; using System.Runtime.InteropServices; public class WinFocus { [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd); [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow); [DllImport("user32.dll")] public static extern void SwitchToThisWindow(IntPtr hWnd, bool fAltTab); [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd); }\';',
    "Add-Type -TypeDefinition $code -ErrorAction SilentlyContinue;",
    "$procs = Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and ($_.MainWindowTitle -or $_.ProcessName) };",
    '$exact = $procs | Where-Object { $_.ProcessName -ieq $query -or "$($_.ProcessName).exe" -ieq $query } | Select-Object -First 1;',
    "if ($exact) { $p = $exact }",
    "elseif ($query -match '^\\d+$') {",
    "    $p = $procs | Where-Object { $_.Id -eq [int]$query } | Select-Object -First 1;",
    "}",
    "if (-not $p) {",
    '    $p = $procs | Where-Object { $_.ProcessName -ilike "*$query*" } | Select-Object -First 1;',
    "}",
    "if (-not $p) {",
    '    $p = $procs | Where-Object { $_.MainWindowTitle -ilike "*$query*" } | Select-Object -First 1;',
    "}",
    "if (-not $p) {",
    '    $avail = ($procs | Select-Object -First 8 | ForEach-Object { if ($_.MainWindowTitle) { "$($_.ProcessName): $($_.MainWindowTitle)" } else { $_.ProcessName } }) -join "; ";',
    '    throw ("No running application or window matching \'" + $query + "\' found. Available windows: " + $avail);',
    "}",
    "if ([WinFocus]::IsIconic($p.MainWindowHandle)) {",
    "    [WinFocus]::ShowWindow($p.MainWindowHandle, 9) | Out-Null;",
    "}",
    "[WinFocus]::ShowWindow($p.MainWindowHandle, 5) | Out-Null;",
    "[WinFocus]::SetForegroundWindow($p.MainWindowHandle) | Out-Null;",
    "[WinFocus]::SwitchToThisWindow($p.MainWindowHandle, $true);",
    "Start-Sleep -Milliseconds 200;",
  ].join("\n");

  try {
    await runPowerShell(script, 15000);
  } catch (err) {
    const stderr = (err as { stderr?: string })?.stderr ?? "";
    const firstStderrLine = stderr
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => l.length > 0);
    if (firstStderrLine?.startsWith("No running application")) {
      throw new Error(`screen_capture: ${firstStderrLine}`);
    }
    const rawMsg = err instanceof Error ? err.message : String(err);
    throw new Error(`screen_capture: failed to focus application '${appQuery}': ${rawMsg}`);
  }
}

/** Bring an application to the foreground on macOS using AppleScript. */
async function focusAppDarwin(appName: string): Promise<void> {
  const sanitized = appName.replace(/["\\]/g, "\\$&");
  const script = `tell application "${sanitized}" to activate`;
  try {
    await execFileAsync("osascript", ["-e", script], { timeout: 10000 });
  } catch (err) {
    throw new Error(
      `screen_capture: failed to focus application '${appName}' on macOS: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/** Bring a window to the foreground on Linux using wmctrl or xdotool. */
async function focusAppLinux(appName: string): Promise<void> {
  try {
    await execFileAsync("wmctrl", ["-a", appName], { timeout: 10000 });
    return;
  } catch {
    // Try xdotool
  }

  try {
    await execFileAsync("xdotool", ["search", "--name", appName, "windowactivate"], {
      timeout: 10000,
    });
    return;
  } catch {
    throw new Error(
      `screen_capture: failed to focus window '${appName}' on Linux. Ensure wmctrl or xdotool is installed.`,
    );
  }
}

/** Default application focus dispatcher by platform. */
export async function defaultFocusRunner(app: string): Promise<void> {
  switch (process.platform) {
    case "win32":
      await focusAppWindows(app);
      break;
    case "darwin":
      await focusAppDarwin(app);
      break;
    default:
      await focusAppLinux(app);
      break;
  }
}

/** Parse single numeric coordinate, failing loud if input is non-numeric or non-finite. */
function parseCoordinate(value: unknown, name: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  const num = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(num)) {
    throw new Error(
      `screen_capture: parameter '${name}' must be a valid number, got '${String(value)}'.`,
    );
  }
  return num;
}

/** Parse a coordinate pair from array [x, y] or object { x, y } / { left, top }. */
function parseCornerPair(value: unknown, name: string): { x: number; y: number } | undefined {
  if (value === undefined || value === null) return undefined;

  if (Array.isArray(value)) {
    if (value.length < 2) {
      throw new Error(`screen_capture: parameter '${name}' array must contain [x, y] coordinates.`);
    }
    const x = Number(value[0]);
    const y = Number(value[1]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      throw new Error(`screen_capture: parameter '${name}' coordinates must be numeric.`);
    }
    return { x, y };
  }

  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const rawX = obj.x ?? obj.left ?? obj.X;
    const rawY = obj.y ?? obj.top ?? obj.Y;
    if (rawX === undefined || rawY === undefined) {
      throw new Error(
        `screen_capture: parameter '${name}' object must contain x and y coordinates.`,
      );
    }
    const x = Number(rawX);
    const y = Number(rawY);
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      throw new Error(`screen_capture: parameter '${name}' coordinates must be numeric.`);
    }
    return { x, y };
  }

  throw new Error(
    `screen_capture: parameter '${name}' must be an array [x, y] or object with coordinates.`,
  );
}

/** Select a monitor from query (index, name, ID, or default primary). */
export function selectMonitor(monitors: MonitorInfo[], query: unknown): MonitorInfo {
  if (monitors.length === 0) {
    throw new Error("screen_capture: no active monitors available.");
  }

  if (query === undefined || query === null || query === "") {
    return monitors.find((m) => m.primary) ?? monitors[0]!;
  }

  if (typeof query === "number" || (typeof query === "string" && /^-?\d+$/.test(query))) {
    const idx = Number(query);
    const match = monitors.find((m) => m.index === idx);
    if (match) return match;
    // Allow 1-based index if out of 0-based range
    if (idx >= 1 && idx <= monitors.length) {
      return monitors[idx - 1]!;
    }
  } else if (typeof query === "string") {
    const norm = query.trim().toLowerCase();
    const match = monitors.find(
      (m) => m.id.toLowerCase() === norm || m.name.toLowerCase() === norm,
    );
    if (match) return match;
  }

  const available = monitors
    .map((m) => `#${m.index}: ${m.name} (${m.width}x${m.height}${m.primary ? ", primary" : ""})`)
    .join("; ");
  throw new Error(
    `screen_capture: invalid monitor '${String(query)}'. Available monitors: ${available}`,
  );
}

/** Calculate and validate crop area against monitor dimensions. */
export function calculateCaptureArea(
  monitor: MonitorInfo,
  topLeft?: { x: number; y: number },
  bottomRight?: { x: number; y: number },
): CaptureArea {
  if (!topLeft && !bottomRight) {
    return {
      x: 0,
      y: 0,
      width: monitor.width,
      height: monitor.height,
      globalX: monitor.x,
      globalY: monitor.y,
    };
  }

  if (!topLeft || !bottomRight) {
    throw new Error(
      "screen_capture: both top-left and bottom-right corners must be specified when defining a capture region.",
    );
  }

  const minX = Math.round(Math.min(topLeft.x, bottomRight.x));
  const maxX = Math.round(Math.max(topLeft.x, bottomRight.x));
  const minY = Math.round(Math.min(topLeft.y, bottomRight.y));
  const maxY = Math.round(Math.max(topLeft.y, bottomRight.y));

  const rawWidth = maxX - minX;
  const rawHeight = maxY - minY;

  if (rawWidth <= 0 || rawHeight <= 0) {
    throw new Error(
      `screen_capture: invalid capture region: width and height must be positive, got width ${rawWidth}, height ${rawHeight}.`,
    );
  }

  if (minX >= monitor.width || minY >= monitor.height) {
    throw new Error(
      `screen_capture: capture region [${minX}, ${minY}] to [${maxX}, ${maxY}] is outside monitor bounds (${monitor.width}x${monitor.height}).`,
    );
  }

  const clampedMinX = Math.max(0, minX);
  const clampedMinY = Math.max(0, minY);
  const clampedMaxX = Math.min(monitor.width, maxX);
  const clampedMaxY = Math.min(monitor.height, maxY);

  const width = clampedMaxX - clampedMinX;
  const height = clampedMaxY - clampedMinY;

  if (width <= 0 || height <= 0) {
    throw new Error(
      `screen_capture: capture region clamped to zero size within monitor bounds (${monitor.width}x${monitor.height}).`,
    );
  }

  return {
    x: clampedMinX,
    y: clampedMinY,
    width,
    height,
    globalX: monitor.x + clampedMinX,
    globalY: monitor.y + clampedMinY,
  };
}

/** Prune old temporary screenshot files to keep scratch storage bounded. */
function pruneOldScreenshots(dir: string, maxFiles = 30, maxAgeMs = 3 * 86400 * 1000): void {
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    const now = Date.now();
    const files: Array<{ path: string; mtime: number }> = [];

    for (const entry of entries) {
      if (entry.isFile() && entry.name.startsWith("capture-") && entry.name.endsWith(".png")) {
        const fullPath = join(dir, entry.name);
        try {
          const st = statSync(fullPath);
          files.push({ path: fullPath, mtime: st.mtimeMs });
        } catch {
          // Ignore transient stat errors
        }
      }
    }

    files.sort((a, b) => b.mtime - a.mtime);

    for (let i = 0; i < files.length; i++) {
      const file = files[i]!;
      if (i >= maxFiles || now - file.mtime > maxAgeMs) {
        try {
          unlinkSync(file.path);
        } catch {
          // Ignore deletion error
        }
      }
    }
  } catch {
    // Non-fatal if directory cannot be read
  }
}

/** Resolve target destination path for capture output, creating parent directory. */
export function resolveOutputPath(
  customPath: string | undefined,
  rootDir: string | undefined,
): string {
  let targetPath: string;

  if (customPath) {
    targetPath = isAbsolute(customPath)
      ? customPath
      : rootDir
        ? join(rootDir, customPath)
        : customPath;
  } else {
    const filename = `capture-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.png`;
    let baseDir = rootDir ? join(rootDir, ".reasonix", "screenshots") : undefined;
    if (baseDir) {
      try {
        mkdirSync(baseDir, { recursive: true });
        pruneOldScreenshots(baseDir);
      } catch {
        baseDir = undefined;
      }
    }
    if (!baseDir) {
      baseDir = join(tmpdir(), "reasonix-screenshots");
      mkdirSync(baseDir, { recursive: true });
      pruneOldScreenshots(baseDir);
    }
    targetPath = join(baseDir, filename);
  }

  // Ensure target parent directory exists
  try {
    mkdirSync(dirname(targetPath), { recursive: true });
  } catch {
    // Ignore if directory already exists
  }

  return targetPath;
}

export function registerScreenCaptureTool(
  registry: ToolRegistry,
  opts: ScreenCaptureToolOptions = {},
): ToolRegistry {
  registry.register({
    name: "screen_capture",
    description: DESCRIPTION,
    readOnly: true,
    parameters: {
      type: "object",
      properties: {
        app: {
          type: "string",
          description:
            "Optional: Application name, process name, or window title substring to bring to the foreground before capturing the screenshot.",
        },
        monitor: {
          type: "integer",
          description:
            "Optional: Monitor index (0 for primary/first monitor, 1 for second, etc.) or monitor device name. Defaults to 0 (primary monitor).",
        },
        top_left_x: {
          type: "number",
          description:
            "Optional: Top-left corner X coordinate in pixels relative to the monitor's top-left corner.",
        },
        top_left_y: {
          type: "number",
          description:
            "Optional: Top-left corner Y coordinate in pixels relative to the monitor's top-left corner.",
        },
        bottom_right_x: {
          type: "number",
          description:
            "Optional: Bottom-right corner X coordinate in pixels relative to the monitor's top-left corner.",
        },
        bottom_right_y: {
          type: "number",
          description:
            "Optional: Bottom-right corner Y coordinate in pixels relative to the monitor's top-left corner.",
        },
        path: {
          type: "string",
          description:
            "Optional: Destination file path for saving the PNG image. If omitted, saves to .reasonix/screenshots/.",
        },
      },
    },
    fn: async (
      args: Record<string, unknown>,
      ctx?: ToolCallContext,
    ): Promise<string | UserContentPart[]> => {
      if (!registry.has("see_image")) {
        return "screen_capture: see_image tool is not registered in the tool registry.";
      }

      const lister = opts.listMonitors ?? defaultListMonitors;
      let monitors: MonitorInfo[];
      try {
        monitors = await lister();
      } catch (err) {
        return `screen_capture: failed to query monitors (${err instanceof Error ? err.message : String(err)})`;
      }

      let selectedMonitor: MonitorInfo;
      try {
        selectedMonitor = selectMonitor(monitors, args.monitor);
      } catch (err) {
        return err instanceof Error ? err.message : String(err);
      }

      // Parse coordinates
      let topLeft: { x: number; y: number } | undefined;
      let bottomRight: { x: number; y: number } | undefined;
      try {
        const x1 = parseCoordinate(args.top_left_x ?? args.x1 ?? args.left, "top_left_x");
        const y1 = parseCoordinate(args.top_left_y ?? args.y1 ?? args.top, "top_left_y");
        topLeft =
          x1 !== undefined && y1 !== undefined
            ? { x: x1, y: y1 }
            : parseCornerPair(args.top_left ?? args.topLeft, "top_left");

        const x2 = parseCoordinate(args.bottom_right_x ?? args.x2 ?? args.right, "bottom_right_x");
        const y2 = parseCoordinate(args.bottom_right_y ?? args.y2 ?? args.bottom, "bottom_right_y");
        bottomRight =
          x2 !== undefined && y2 !== undefined
            ? { x: x2, y: y2 }
            : parseCornerPair(args.bottom_right ?? args.bottomRight, "bottom_right");
      } catch (err) {
        return err instanceof Error ? err.message : String(err);
      }

      let cropArea: CaptureArea;
      try {
        cropArea = calculateCaptureArea(selectedMonitor, topLeft, bottomRight);
      } catch (err) {
        return err instanceof Error ? err.message : String(err);
      }

      // Determine output path
      const customPath =
        typeof args.path === "string" && args.path.trim().length > 0 ? args.path.trim() : undefined;
      const rootDir = ctx?.rootDir ?? opts.rootDir;
      const outputPath = resolveOutputPath(customPath, rootDir);

      // Bring target application to foreground if requested
      const rawApp = args.app ?? args.window ?? args.window_title ?? args.focus_app;
      const targetApp =
        (typeof rawApp === "string" && rawApp.trim().length > 0) || typeof rawApp === "number"
          ? String(rawApp).trim()
          : undefined;

      if (targetApp) {
        const focuser = opts.focusRunner ?? defaultFocusRunner;
        try {
          await focuser(targetApp);
        } catch (err) {
          return err instanceof Error ? err.message : String(err);
        }
      }

      // Execute capture
      const runner = opts.captureRunner ?? defaultCaptureRunner;
      try {
        await runner({
          monitor: selectedMonitor,
          crop: cropArea,
          outputPath,
        });
      } catch (err) {
        return `screen_capture: capture failed (${err instanceof Error ? err.message : String(err)})`;
      }

      // Feed directly to see_image
      const seeImageResult = await registry.dispatch(
        "see_image",
        JSON.stringify({ path: outputPath }),
        ctx,
      );

      // Enhance text part in see_image result with capture metadata
      if (Array.isArray(seeImageResult)) {
        const parts = [...seeImageResult] as UserContentPart[];
        const textPart = parts.find((p): p is { type: "text"; text: string } => p.type === "text");
        const areaDesc = `[${cropArea.x}, ${cropArea.y}] to [${cropArea.x + cropArea.width}, ${cropArea.y + cropArea.height}]`;
        const appDesc = targetApp ? `app "${targetApp}", ` : "";
        const metaPrefix = `Screen capture (${appDesc}monitor ${selectedMonitor.index} [${selectedMonitor.name}], area ${areaDesc}): `;
        if (textPart) {
          textPart.text = `${metaPrefix}${textPart.text}`;
        }
        return parts;
      }

      return seeImageResult;
    },
  });

  return registry;
}
