import { describe, expect, it } from "vitest";
import { shouldReplaceDeletedSession } from "../src/cli/commands/desktop.js";

describe("desktop session deletion synchronization", () => {
  it("replaces the backend-bound session after deleting the active session", () => {
    expect(shouldReplaceDeletedSession("active-session", "active-session", true)).toBe(true);
  });

  it("keeps the current conversation when an inactive session is deleted", () => {
    expect(shouldReplaceDeletedSession("active-session", "older-session", true)).toBe(false);
  });

  it("does not replace the current session when deletion fails", () => {
    expect(shouldReplaceDeletedSession("active-session", "active-session", false)).toBe(false);
  });
});
