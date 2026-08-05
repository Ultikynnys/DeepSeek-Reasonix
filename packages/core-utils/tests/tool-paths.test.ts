import { describe, expect, it } from "vitest";
import { FILE_PATH_TOOLS, extractPathsFromArgs, isFilePathTool } from "../src/tool-paths.js";

describe("extractPathsFromArgs", () => {
  it("extracts the top-level path", () => {
    expect(extractPathsFromArgs(JSON.stringify({ path: "src/a.ts" }))).toEqual(["src/a.ts"]);
  });

  it("extracts every edits[].path (multi_edit)", () => {
    expect(
      extractPathsFromArgs(JSON.stringify({ edits: [{ path: "src/a.ts" }, { path: "src/b.ts" }] })),
    ).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("returns [] for malformed, empty, or path-less args", () => {
    expect(extractPathsFromArgs("")).toEqual([]);
    expect(extractPathsFromArgs(null)).toEqual([]);
    expect(extractPathsFromArgs(undefined)).toEqual([]);
    expect(extractPathsFromArgs("{not json")).toEqual([]);
    expect(extractPathsFromArgs(JSON.stringify({ command: "ls" }))).toEqual([]);
    expect(extractPathsFromArgs(JSON.stringify({ path: "" }))).toEqual([]);
    expect(extractPathsFromArgs(JSON.stringify({ path: 42 }))).toEqual([]);
  });

  it("preserves duplicates for the caller to dedupe", () => {
    expect(
      extractPathsFromArgs(JSON.stringify({ edits: [{ path: "src/a.ts" }, { path: "src/a.ts" }] })),
    ).toEqual(["src/a.ts", "src/a.ts"]);
  });
});

describe("FILE_PATH_TOOLS / isFilePathTool", () => {
  it("covers the tools whose args feed the context-file list", () => {
    expect(FILE_PATH_TOOLS).toEqual(["read_file", "write_file", "edit_file", "multi_edit"]);
    for (const name of FILE_PATH_TOOLS) expect(isFilePathTool(name)).toBe(true);
  });

  it("rejects tools that don't put files in context", () => {
    expect(isFilePathTool("run_command")).toBe(false);
    expect(isFilePathTool("search_content")).toBe(false);
  });
});
