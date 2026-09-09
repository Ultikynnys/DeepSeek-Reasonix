import { describe, expect, it } from "vitest";
import { toWorkspaceAbsolute, toWorkspaceRelative } from "./workspace-path";

describe("workspace paths", () => {
  it("relativizes only paths inside the workspace boundary", () => {
    expect(toWorkspaceRelative("/repo/src/App.tsx", "/repo")).toBe("src/App.tsx");
    expect(toWorkspaceRelative("/repo", "/repo")).toBe(".");
    expect(toWorkspaceRelative("/repo-other/file.ts", "/repo")).toBe("/repo-other/file.ts");
  });

  it("handles Windows paths case-insensitively and preserves absolute outsiders", () => {
    expect(toWorkspaceRelative("C:\\Repo\\src\\App.tsx", "c:\\repo")).toBe("src/App.tsx");
    expect(toWorkspaceRelative("C:\\Repository\\file.ts", "C:\\Repo")).toBe(
      "C:/Repository/file.ts",
    );
  });

  it("resolves relative paths with the workspace platform separator", () => {
    expect(toWorkspaceAbsolute("src/App.tsx", "/repo")).toBe("/repo/src/App.tsx");
    expect(toWorkspaceAbsolute("src/App.tsx", "C:\\repo")).toBe("C:\\repo\\src\\App.tsx");
    expect(toWorkspaceAbsolute("/outside/file.ts", "/repo")).toBe("/outside/file.ts");
  });
});
