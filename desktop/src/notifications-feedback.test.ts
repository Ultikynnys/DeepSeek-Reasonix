import { describe, expect, it } from "vitest";
import { COMPLETION_NOTIFY_MIN_MS, shouldAppendCompletionNotice } from "./notifications";

describe("desktop completion feedback", () => {
  it("appends in-window feedback when a long task completes while focused", () => {
    expect(
      shouldAppendCompletionNotice({
        wasBusy: true,
        isBusy: false,
        busyDurationMs: COMPLETION_NOTIFY_MIN_MS,
        focused: true,
      }),
    ).toBe(true);
  });

  it("does not append in-window feedback for short tasks", () => {
    expect(
      shouldAppendCompletionNotice({
        wasBusy: true,
        isBusy: false,
        busyDurationMs: COMPLETION_NOTIFY_MIN_MS - 1,
        focused: true,
      }),
    ).toBe(false);
  });
});
