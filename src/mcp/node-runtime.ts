/** Auto-provisions portable Node.js and npx when missing on the system. */

import { spawnSync } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { arch, platform } from "node:os";
import { delimiter, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { reasonixHome } from "../reasonix-home.js";
import { resolveExecutable } from "../tools/shell/exec.js";

export const PORTABLE_NODE_VERSION = "v22.14.0";

/** Compute the official Node.js download URL for the host OS and architecture. */
export function getNodeDownloadUrl(
  os = platform(),
  architecture = arch(),
  version = PORTABLE_NODE_VERSION,
): { url: string; archiveName: string; format: "zip" | "tar" } {
  if (os === "win32") {
    const archiveName = `node-${version}-win-x64.zip`;
    return {
      url: `https://nodejs.org/dist/${version}/${archiveName}`,
      archiveName,
      format: "zip",
    };
  }
  if (os === "darwin") {
    const targetArch = architecture === "arm64" ? "arm64" : "x64";
    const archiveName = `node-${version}-darwin-${targetArch}.tar.gz`;
    return {
      url: `https://nodejs.org/dist/${version}/${archiveName}`,
      archiveName,
      format: "tar",
    };
  }
  const targetArch = architecture === "arm64" ? "arm64" : "x64";
  const archiveName = `node-${version}-linux-${targetArch}.tar.xz`;
  return {
    url: `https://nodejs.org/dist/${version}/${archiveName}`,
    archiveName,
    format: "tar",
  };
}

/** Check if npx is available in the provided env or system PATH. */
export function isNpxOnPath(env: NodeJS.ProcessEnv = process.env): boolean {
  if (process.platform === "win32") {
    const resolved = resolveExecutable("npx", { env });
    return Boolean(resolved && resolved !== "npx");
  }
  const pathVal = env.PATH ?? "";
  const dirs = pathVal.split(delimiter).filter(Boolean);
  return dirs.some((dir) => existsSync(join(dir, "npx")));
}

/** Base directory for Reasonix-managed portable Node runtime. */
export function getPortableNodeDir(homeDirOverride?: string): string {
  return join(reasonixHome(homeDirOverride), "tools", "node");
}

function checkNodeBinCandidate(dir: string): string | null {
  if (process.platform === "win32") {
    if (existsSync(join(dir, "npx.cmd")) || existsSync(join(dir, "node.exe"))) {
      return dir;
    }
  } else if (existsSync(join(dir, "bin", "npx"))) {
    return join(dir, "bin");
  }
  return null;
}

/** Locate the bin directory of an extracted portable Node distribution. */
export function findPortableNodeBinDir(baseDir: string): string | null {
  if (!existsSync(baseDir)) return null;

  const direct = checkNodeBinCandidate(baseDir);
  if (direct) return direct;

  try {
    for (const entry of readdirSync(baseDir)) {
      const candidate = checkNodeBinCandidate(join(baseDir, entry));
      if (candidate) return candidate;
    }
  } catch {
    // Directory unreadable
  }
  return null;
}

/** Prepend portable Node binary directory to PATH in the environment. */
export function addBinDirToPath(
  binDir: string,
  env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const currentPath = env.PATH ?? env.Path ?? "";
  const updatedPath = currentPath ? `${binDir}${delimiter}${currentPath}` : binDir;
  env.PATH = updatedPath;
  if (process.platform === "win32") {
    env.Path = updatedPath;
  }
  return env;
}

/** Download and extract official portable Node.js LTS into ~/.reasonix/tools/node. */
export async function installPortableNode(
  opts: {
    homeDir?: string;
    onProgress?: (message: string) => void;
  } = {},
): Promise<{ ok: boolean; binDir?: string; reason?: string }> {
  const targetDir = getPortableNodeDir(opts.homeDir);
  mkdirSync(targetDir, { recursive: true });

  const downloadInfo = getNodeDownloadUrl();
  opts.onProgress?.(`Downloading portable Node.js runtime (${downloadInfo.archiveName})...`);

  const archivePath = join(targetDir, downloadInfo.archiveName);
  try {
    const res = await fetch(downloadInfo.url);
    if (!res.ok || !res.body) {
      return { ok: false, reason: `Failed to download Node.js: HTTP ${res.status}` };
    }
    // Stream response to disk
    const fileStream = createWriteStream(archivePath);
    await pipeline(
      Readable.fromWeb(res.body as import("node:stream/web").ReadableStream),
      fileStream,
    );

    opts.onProgress?.("Extracting Node.js runtime...");
    // Extract using bsdtar (built-in on Windows 10/11 and standard on Linux/macOS)
    const extractRes = spawnSync("tar", ["-xf", archivePath, "-C", targetDir], {
      windowsHide: true,
      stdio: "pipe",
    });

    if (extractRes.status !== 0) {
      const errDetail = extractRes.stderr?.toString() || extractRes.stdout?.toString() || "";
      return {
        ok: false,
        reason: `Archive extraction failed with code ${extractRes.status}: ${errDetail}`,
      };
    }

    // Clean up archive
    try {
      rmSync(archivePath, { force: true });
    } catch {
      // Ignore cleanup error
    }

    const binDir = findPortableNodeBinDir(targetDir);
    if (!binDir) {
      return { ok: false, reason: "Extracted Node.js binaries could not be located" };
    }

    addBinDirToPath(binDir);
    return { ok: true, binDir };
  } catch (err) {
    return { ok: false, reason: (err as Error).message };
  }
}

/** Ensure npx is available on the system, auto-installing portable Node if missing. */
export async function ensureNpxAvailable(
  opts: {
    homeDir?: string;
    onProgress?: (message: string) => void;
  } = {},
): Promise<{ ok: boolean; binDir?: string; reason?: string }> {
  // 1. Check system PATH
  if (isNpxOnPath()) {
    return { ok: true };
  }

  // 2. Check existing portable Node
  const existingDir = getPortableNodeDir(opts.homeDir);
  const existingBin = findPortableNodeBinDir(existingDir);
  if (existingBin) {
    addBinDirToPath(existingBin);
    return { ok: true, binDir: existingBin };
  }

  // 3. Auto-install portable Node
  return await installPortableNode(opts);
}
