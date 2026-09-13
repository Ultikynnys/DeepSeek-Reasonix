import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  addBinDirToPath,
  findPortableNodeBinDir,
  getNodeDownloadUrl,
  isNpxOnPath,
} from "../src/mcp/node-runtime.js";

describe("node-runtime detection and paths", () => {
  it("generates correct download URLs for major platforms", () => {
    const win = getNodeDownloadUrl("win32", "x64", "v22.14.0");
    expect(win.url).toBe("https://nodejs.org/dist/v22.14.0/node-v22.14.0-win-x64.zip");
    expect(win.format).toBe("zip");

    const darwinArm = getNodeDownloadUrl("darwin", "arm64", "v22.14.0");
    expect(darwinArm.url).toBe(
      "https://nodejs.org/dist/v22.14.0/node-v22.14.0-darwin-arm64.tar.gz",
    );
    expect(darwinArm.format).toBe("tar");

    const linux = getNodeDownloadUrl("linux", "x64", "v22.14.0");
    expect(linux.url).toBe("https://nodejs.org/dist/v22.14.0/node-v22.14.0-linux-x64.tar.xz");
    expect(linux.format).toBe("tar");
  });

  it("detects when npx is missing from an empty PATH", () => {
    expect(isNpxOnPath({ PATH: "" })).toBe(false);
  });

  it("finds portable node bin directory in standard layout", () => {
    const tmp = join(tmpdir(), `node-rt-test-${Date.now()}`);
    mkdirSync(tmp, { recursive: true });

    if (process.platform === "win32") {
      writeFileSync(join(tmp, "npx.cmd"), "@echo off\n");
      const found = findPortableNodeBinDir(tmp);
      expect(found).toBe(tmp);
    } else {
      const bin = join(tmp, "bin");
      mkdirSync(bin, { recursive: true });
      writeFileSync(join(bin, "npx"), "#!/bin/sh\n");
      const found = findPortableNodeBinDir(tmp);
      expect(found).toBe(bin);
    }
  });

  it("prepends portable bin dir to PATH", () => {
    const fakeEnv: NodeJS.ProcessEnv = { PATH: "/usr/bin:/bin" };
    addBinDirToPath("/opt/reasonix/node/bin", fakeEnv);
    expect(fakeEnv.PATH?.startsWith("/opt/reasonix/node/bin")).toBe(true);
  });
});
