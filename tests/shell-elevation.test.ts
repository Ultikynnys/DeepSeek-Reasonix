import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveApprovalPrompt, toApprovalPrompt } from "@reasonix/core-utils";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadElevationEnabled, saveElevationEnabled } from "../src/config.js";
import { type ConfirmationChoice, PauseGate } from "../src/core/pause-gate.js";
import { ToolRegistry } from "../src/tools.js";
import {
  ELEVATION_DECLINED_EXIT,
  buildElevatedInvocation,
  registerShellTools,
  runCommandElevated,
} from "../src/tools/shell.js";
import { assembleResult } from "../src/tools/shell/exec.js";

/** Records the gate call and denies — denial keeps the elevated spawn from running. */
class SpyGate extends PauseGate {
  lastCall: Parameters<PauseGate["ask"]>[0] | null = null;
  override ask = ((opts: Parameters<PauseGate["ask"]>[0]) => {
    this.lastCall = opts;
    return Promise.resolve({ type: "deny" } as ConfirmationChoice);
  }) as PauseGate["ask"];
}

describe("buildElevatedInvocation", () => {
  it("builds a powershell launcher that elevates via Start-Process -Verb RunAs", () => {
    const inv = buildElevatedInvocation("C:\\Temp\\rsx-elev-abc.cmd");
    expect(inv.bin).toBe("powershell.exe");
    expect(inv.args.slice(0, 3)).toEqual(["-NoProfile", "-NonInteractive", "-Command"]);
    const script = inv.args[3] ?? "";
    expect(script).toContain("Start-Process");
    expect(script).toContain("-Verb RunAs");
    expect(script).toContain("-Wait");
    expect(script).toContain("-PassThru");
    expect(script).toContain("rsx-elev-abc.cmd");
    // A cancelled UAC prompt must map to a distinct, detectable exit code.
    expect(script).toContain(`exit ${ELEVATION_DECLINED_EXIT}`);
    expect(script).toContain("ELEVATION_DECLINED");
  });
});

describe("runCommandElevated", () => {
  it("refuses on non-Windows platforms", async () => {
    await expect(
      runCommandElevated("echo hi", { cwd: process.cwd(), platform: "linux" }),
    ).rejects.toThrow(/only supported on Windows/);
  });
});

describe("assembleResult", () => {
  it("truncates with a marker when output exceeds maxChars", () => {
    const r = assembleResult({
      buf: "x".repeat(100),
      totalBytes: 100,
      rawByteLength: 100,
      exitCode: 0,
      durationMs: 1,
      timedOut: false,
      maxChars: 10,
    });
    expect(r.truncated).toBe(true);
    expect(r.output.startsWith("xxxxxxxxxx")).toBe(true);
    expect(r.output).toContain("[… truncated 90 chars …]");
  });

  it("passes output through unchanged when under the cap", () => {
    const r = assembleResult({
      buf: "hello",
      totalBytes: 5,
      rawByteLength: 5,
      exitCode: 0,
      durationMs: 1,
      timedOut: false,
      maxChars: 100,
    });
    expect(r.truncated).toBe(false);
    expect(r.output).toBe("hello");
  });
});

describe("elevation config gate", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "reasonix-elev-cfg-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("defaults to disabled and round-trips through save/load", () => {
    const cfgPath = join(dir, "config.json");
    expect(loadElevationEnabled(cfgPath)).toBe(false);
    saveElevationEnabled(true, cfgPath);
    expect(loadElevationEnabled(cfgPath)).toBe(true);
    saveElevationEnabled(false, cfgPath);
    expect(loadElevationEnabled(cfgPath)).toBe(false);
  });
});

describe("run_command elevate dispatch", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "reasonix-elev-"));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("rejects elevate=true on non-Windows", async () => {
    const registry = new ToolRegistry();
    registerShellTools(registry, { rootDir: tmp, platform: "linux", elevationEnabled: true });
    const out = await registry.dispatch(
      "run_command",
      JSON.stringify({ command: "echo hi", elevate: true }),
    );
    expect(out).toMatch(/only supported on Windows/);
  });

  it("rejects elevate=true when elevation is disabled, even on Windows", async () => {
    const registry = new ToolRegistry();
    registerShellTools(registry, { rootDir: tmp, platform: "win32", elevationEnabled: false });
    const out = await registry.dispatch(
      "run_command",
      JSON.stringify({ command: "echo hi", elevate: true }),
    );
    expect(out).toMatch(/elevate=true is disabled/);
  });

  it("always routes an elevated command through the gate, even when allowlisted", async () => {
    const registry = new ToolRegistry();
    registerShellTools(registry, { rootDir: tmp, platform: "win32", elevationEnabled: true });
    const spy = new SpyGate();
    // `git status` IS allowlisted — elevation must override that and force the gate.
    const out = await registry.dispatch(
      "run_command",
      JSON.stringify({ command: "git status", elevate: true }),
      { confirmationGate: spy },
    );
    expect(spy.lastCall).not.toBeNull();
    expect(spy.lastCall!.kind).toBe("run_command");
    expect(spy.lastCall!.payload).toMatchObject({ command: "git status", elevated: true });
    expect(out).toMatch(/user denied/);
  });

  it("does NOT gate an allowlisted command when elevate is not set", async () => {
    const registry = new ToolRegistry();
    registerShellTools(registry, { rootDir: tmp });
    const spy = new SpyGate();
    await registry.dispatch("run_command", JSON.stringify({ command: "git status" }), {
      confirmationGate: spy,
    });
    expect(spy.lastCall).toBeNull();
  });
});

describe("elevated approval prompt", () => {
  it("renders an error-tone ELEVATED prompt with no always-allow action", () => {
    const prompt = toApprovalPrompt({
      id: 1,
      kind: "run_command",
      payload: { command: "smartctl -a /dev/nvme0", elevated: true },
    });
    expect(prompt.tone).toBe("error");
    expect(prompt.title).toContain("ELEVATED");
    expect(prompt.meta?.elevation).toBe("UAC consent required");
    expect(prompt.actions.some((a) => a.kind === "allow_always")).toBe(false);
    expect(prompt.actions.map((a) => a.id)).toContain("run_once");
    // No prefix means "always allow" can never be reconstructed downstream.
    expect(prompt.data?.prefix).toBeUndefined();
    expect(resolveApprovalPrompt(prompt, "run_once")).toEqual({ type: "run_once" });
  });

  it("keeps the standard warn prompt + always-allow for non-elevated commands", () => {
    const prompt = toApprovalPrompt({
      id: 2,
      kind: "run_command",
      payload: { command: "npm install left-pad" },
    });
    expect(prompt.tone).toBe("warn");
    expect(prompt.title).toBe("Run command");
    expect(prompt.actions.some((a) => a.kind === "allow_always")).toBe(true);
  });
});
