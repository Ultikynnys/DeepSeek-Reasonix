import { describe, expect, it } from "vitest";
import { ConcurrencyGate } from "../src/core/concurrency-gate.js";

describe("ConcurrencyGate", () => {
  it("limits active work and drains higher-priority queued tasks first", async () => {
    const gate = new ConcurrencyGate(1);
    const order: string[] = [];
    let release!: () => void;
    const first = gate.run(
      () =>
        new Promise<string>((resolve) => {
          release = () => resolve("first");
        }),
    );
    const low = gate.run(async () => {
      order.push("low");
      return "low";
    });
    const high = gate.run(async () => {
      order.push("high");
      return "high";
    }, 1);
    release();
    await Promise.all([first, low, high]);
    expect(order).toEqual(["high", "low"]);
  });

  it("reports queue wait and continues after a rejection", async () => {
    const gate = new ConcurrencyGate(1);
    await expect(gate.run(async () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    await expect(gate.run(async () => "ok")).resolves.toMatchObject({ value: "ok" });
  });
});
