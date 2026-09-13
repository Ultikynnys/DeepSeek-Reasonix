/** StdioTransport.close() must terminate server trees and remain safe on kill errors. */

import type { ChildProcess } from "node:child_process";
import { describe, expect, it } from "vitest";
import { StdioTransport } from "../src/mcp/stdio.js";

describe("StdioTransport.close()", () => {
  it("swallows kill() EINVAL without throwing", async () => {
    const t = new StdioTransport({
      command: "node",
      args: ["-e", "process.exit(0)"],
      shell: false,
    });
    // Let child exit so .kill() hits a reaped/zombie-like state.
    await new Promise((r) => setTimeout(r, 200));
    await expect(t.close()).resolves.toBeUndefined();
  });

  it("does not throw on failed spawn", async () => {
    const t = new StdioTransport({
      command: "nonexistent_command_that_does_not_exist_12345",
      shell: false,
    });
    const iter = t.messages();
    const msg = await iter[Symbol.asyncIterator]().next();
    expect(msg.value?.error?.code).toBe(-32000);
    await expect(t.close()).resolves.toBeUndefined();
  });

  it("is idempotent — second close() is a no-op", async () => {
    const t = new StdioTransport({
      command: "node",
      args: ["-e", "setTimeout(() => {}, 5000)"],
      shell: false,
    });
    await t.close();
    await expect(t.close()).resolves.toBeUndefined();
  });

  it("terminates through the process-tree path before the direct-child fallback", async () => {
    const t = new StdioTransport({
      command: "node",
      args: ["-e", "setTimeout(() => {}, 5000)"],
      shell: false,
    });
    const child = (t as unknown as { child: ChildProcess }).child;
    const originalKill = child.kill.bind(child);
    let directKillCalled = false;
    child.kill = (signal?: NodeJS.Signals | number) => {
      directKillCalled = true;
      return originalKill(signal);
    };
    await expect(t.close()).resolves.toBeUndefined();
    expect(directKillCalled).toBe(false);
    try {
      originalKill();
    } catch {
      /* already dead */
    }
  });
});
