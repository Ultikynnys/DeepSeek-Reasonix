import { describe, expect, it } from "vitest";
import {
  shouldMaterializeFreshSession,
  shouldMaterializeRestoredSession,
  shouldReplaceDeletedSession,
} from "../src/cli/commands/desktop.js";

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

  it("keeps deletion replacements virtual so deleted sessions stay absent", () => {
    expect(shouldMaterializeFreshSession("session-delete")).toBe(false);
  });

  it("still materializes an explicit New chat immediately", () => {
    expect(shouldMaterializeFreshSession("new-chat")).toBe(true);
  });

  it("does not resurrect a restored tab whose session was deleted", () => {
    // The persisted tab points at a session name that no longer exists — it
    // must stay virtual so the deletion survives a restart.
    expect(shouldMaterializeRestoredSession({ session: "deleted-session" })).toBe(false);
  });

  it("materializes a genuinely new tab with no persisted session", () => {
    expect(shouldMaterializeRestoredSession(undefined)).toBe(true);
    expect(shouldMaterializeRestoredSession({})).toBe(true);
  });
});
