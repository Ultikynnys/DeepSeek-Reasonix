import { describe, expect, it, vi } from "vitest";
import {
  COMPACTION_MAX_ATTEMPTS,
  COMPACTION_RETRY_COUNT,
  compactionRetryBudgetMs,
  isRetryableCompactionError,
  withCompactionRetry,
} from "../src/loop/compaction-retry.js";

describe("compaction retry policy", () => {
  it("always allows three retries after the initial attempt", async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      const pending = withCompactionRetry({
        retryDelayMs: 10,
        attempt: async () => {
          calls++;
          if (calls <= COMPACTION_RETRY_COUNT) {
            throw new Error("summarizer returned empty content");
          }
          return "summary";
        },
      });

      await vi.runAllTimersAsync();
      await expect(pending).resolves.toBe("summary");
      expect(COMPACTION_RETRY_COUNT).toBe(3);
      expect(COMPACTION_MAX_ATTEMPTS).toBe(4);
      expect(calls).toBe(4);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops after exactly three retries when every attempt fails", async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      const pending = withCompactionRetry({
        retryDelayMs: 10,
        attempt: async () => {
          calls++;
          throw new Error("summarizer returned empty content");
        },
      });
      const rejection = expect(pending).rejects.toThrow("summarizer returned empty content");

      await vi.runAllTimersAsync();
      await rejection;
      expect(calls).toBe(4);
    } finally {
      vi.useRealTimers();
    }
  });

  it("budgets every attempt and delay and retries invalid summary output", () => {
    expect(compactionRetryBudgetMs(1_000, 4, 100)).toBe(4_300);
    expect(isRetryableCompactionError("fold-timeout")).toBe(true);
    expect(isRetryableCompactionError("forced-summary-timeout")).toBe(true);
    expect(isRetryableCompactionError("summarizer returned empty content")).toBe(true);
    expect(isRetryableCompactionError("summarizer returned a degenerate summary (4 chars)")).toBe(
      true,
    );
    expect(isRetryableCompactionError("fold-aborted")).toBe(false);
    expect(isRetryableCompactionError("aborted by user")).toBe(false);
  });
});
