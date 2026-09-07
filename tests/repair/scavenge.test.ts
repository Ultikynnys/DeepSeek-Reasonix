import { describe, expect, it } from "vitest";
import { scavengeToolCalls } from "../../src/repair/scavenge.js";

const allowed = new Set(["get_weather", "search"]);

describe("scavengeToolCalls", () => {
  it("returns nothing for null reasoning", () => {
    const r = scavengeToolCalls(null, { allowedNames: allowed });
    expect(r.calls).toEqual([]);
  });

  it('extracts pattern 1: {"name", "arguments"}', () => {
    const reasoning = `thinking... I should call {"name": "get_weather", "arguments": {"city": "SF"}}`;
    const r = scavengeToolCalls(reasoning, { allowedNames: allowed });
    expect(r.calls.length).toBe(1);
    expect(r.calls[0]!.function.name).toBe("get_weather");
    expect(JSON.parse(r.calls[0]!.function.arguments)).toEqual({ city: "SF" });
  });

  it("extracts OpenAI-style envelope", () => {
    const reasoning = `plan: {"type":"function","function":{"name":"search","arguments":"{\\"q\\":\\"ts\\"}"}}`;
    const r = scavengeToolCalls(reasoning, { allowedNames: allowed });
    expect(r.calls[0]!.function.name).toBe("search");
    expect(JSON.parse(r.calls[0]!.function.arguments)).toEqual({ q: "ts" });
  });

  it("extracts tool_name / tool_args variant", () => {
    const reasoning = `decide: {"tool_name": "search", "tool_args": {"q": "deepseek"}}`;
    const r = scavengeToolCalls(reasoning, { allowedNames: allowed });
    expect(r.calls[0]!.function.name).toBe("search");
    expect(JSON.parse(r.calls[0]!.function.arguments)).toEqual({ q: "deepseek" });
  });

  it("ignores tools not in the allowed set", () => {
    const reasoning = `{"name": "rm_rf_slash", "arguments": {}}`;
    const r = scavengeToolCalls(reasoning, { allowedNames: allowed });
    expect(r.calls).toEqual([]);
  });

  it("respects maxCalls", () => {
    const reasoning = Array.from({ length: 6 })
      .map(() => `{"name": "search", "arguments": {"q": "x"}}`)
      .join(" then ");
    const r = scavengeToolCalls(reasoning, { allowedNames: allowed, maxCalls: 2 });
    expect(r.calls.length).toBe(2);
  });

  it("extracts a DSML invoke block with string + JSON parameters", () => {
    const dsmlAllowed = new Set(["filesystem_edit_file"]);
    const input = [
      "Let me make the edit.",
      "",
      '<｜DSML｜function_calls> <｜DSML｜invoke name="filesystem_edit_file">',
      '  <｜DSML｜parameter name="path" string="true">F:/x.html</｜DSML｜parameter>',
      '  <｜DSML｜parameter name="edits" string="false">[{"oldText":"a","newText":"b"}]</｜DSML｜parameter>',
      "</｜DSML｜invoke> </｜DSML｜function_calls>",
    ].join("\n");
    const r = scavengeToolCalls(input, { allowedNames: dsmlAllowed });
    expect(r.calls.length).toBe(1);
    const call = r.calls[0]!;
    expect(call.function.name).toBe("filesystem_edit_file");
    const args = JSON.parse(call.function.arguments);
    expect(args.path).toBe("F:/x.html");
    expect(args.edits).toEqual([{ oldText: "a", newText: "b" }]);
    expect(r.notes[0]).toMatch(/DSML/);
  });

  it("accepts ASCII pipe DSML variant too", () => {
    const dsmlAllowed = new Set(["search"]);
    const input =
      '<|DSML|invoke name="search"><|DSML|parameter name="q" string="true">ts</|DSML|parameter></|DSML|invoke>';
    const r = scavengeToolCalls(input, { allowedNames: dsmlAllowed });
    expect(r.calls.length).toBe(1);
    expect(JSON.parse(r.calls[0]!.function.arguments)).toEqual({ q: "ts" });
  });

  it("DSML call with unknown tool name is skipped (allow-list guards us)", () => {
    const input =
      '<｜DSML｜invoke name="rm_rf_slash"><｜DSML｜parameter name="x" string="true">y</｜DSML｜parameter></｜DSML｜invoke>';
    const r = scavengeToolCalls(input, { allowedNames: allowed });
    expect(r.calls).toEqual([]);
  });

  it("DSML 'string=false' with malformed JSON falls back to literal text (loses no data)", () => {
    const dsmlAllowed = new Set(["search"]);
    const input =
      '<｜DSML｜invoke name="search"><｜DSML｜parameter name="q" string="false">not valid json</｜DSML｜parameter></｜DSML｜invoke>';
    const r = scavengeToolCalls(input, { allowedNames: dsmlAllowed });
    expect(r.calls.length).toBe(1);
    expect(JSON.parse(r.calls[0]!.function.arguments)).toEqual({ q: "not valid json" });
  });

  it("does not double-count: JSON args inside a DSML block don't become separate calls", () => {
    const dsmlAllowed = new Set(["filesystem_edit_file"]);
    // The inner JSON is a param value, not a standalone scavenge target.
    const input =
      '<｜DSML｜invoke name="filesystem_edit_file"><｜DSML｜parameter name="edits" string="false">{"name": "filesystem_edit_file", "arguments": {}}</｜DSML｜parameter></｜DSML｜invoke>';
    const r = scavengeToolCalls(input, { allowedNames: dsmlAllowed });
    // Expect exactly one call — the DSML wrapper. If Pattern B also
    // fired on the inner JSON we'd see two.
    expect(r.calls.length).toBe(1);
  });

  it("recovers tool names corrupted by repetition stalls", () => {
    const dsmlAllowed = new Set(["read_file"]);
    const input =
      '<｜DSML｜invoke name="read_fileread_fileread_fileread_file"><｜DSML｜parameter name="path" string="true">foo.txt</｜DSML｜parameter></｜DSML｜invoke>';
    const r = scavengeToolCalls(input, { allowedNames: dsmlAllowed });
    expect(r.calls.length).toBe(1);
    expect(r.calls[0]!.function.name).toBe("read_file");
    expect(JSON.parse(r.calls[0]!.function.arguments)).toEqual({ path: "foo.txt" });
  });

  it("recovers raw JSON tool calls with repeating tool name", () => {
    const dsmlAllowed = new Set(["read_file"]);
    const input = `I will call {"name": "read_fileread_fileread_file", "arguments": {"path": "bar.txt"}}`;
    const r = scavengeToolCalls(input, { allowedNames: dsmlAllowed });
    expect(r.calls.length).toBe(1);
    expect(r.calls[0]!.function.name).toBe("read_file");
    expect(JSON.parse(r.calls[0]!.function.arguments)).toEqual({ path: "bar.txt" });
  });

  it("recovers an unfenced SEARCH/REPLACE block as edit_file", () => {
    const input = [
      "Applying the exact ordering.",
      "src/cli/commands/desktop.ts",
      "<<<<<<< SEARCH",
      "loadDisableAutoCompaction,",
      "loadDisabledModels,",
      "=======",
      "loadDisabledModels,",
      "loadDisableAutoCompaction,",
      ">>>>>>> REPLACE",
    ].join("\n");
    const r = scavengeToolCalls(input, { allowedNames: new Set(["edit_file"]) });
    expect(r.calls).toHaveLength(1);
    expect(r.calls[0]!.function.name).toBe("edit_file");
    expect(JSON.parse(r.calls[0]!.function.arguments)).toEqual({
      path: "src/cli/commands/desktop.ts",
      search: "loadDisableAutoCompaction,\nloadDisabledModels,",
      replace: "loadDisabledModels,\nloadDisableAutoCompaction,",
    });
    expect(r.recoveredRanges).toHaveLength(1);
  });

  it("maps an empty SEARCH block to write_file", () => {
    const input = [
      "src/new.ts",
      "<<<<<<< SEARCH",
      "=======",
      "export const value = 1;",
      ">>>>>>> REPLACE",
    ].join("\n");
    const r = scavengeToolCalls(input, { allowedNames: new Set(["write_file"]) });
    expect(r.calls).toHaveLength(1);
    expect(r.calls[0]!.function.name).toBe("write_file");
    expect(JSON.parse(r.calls[0]!.function.arguments)).toEqual({
      path: "src/new.ts",
      content: "export const value = 1;",
    });
  });

  it("leaves fenced examples, incomplete blocks, and unavailable edit tools inert", () => {
    const complete = [
      "src/a.ts",
      "<<<<<<< SEARCH",
      "old",
      "=======",
      "new",
      ">>>>>>> REPLACE",
    ].join("\n");
    const fenced = `Example:\n\`\`\`text\n${complete}\n\`\`\``;
    expect(scavengeToolCalls(fenced, { allowedNames: new Set(["edit_file"]) }).calls).toEqual([]);
    expect(
      scavengeToolCalls(`${complete}\n`.replace(">>>>>>> REPLACE", ""), {
        allowedNames: new Set(["edit_file"]),
      }).calls,
    ).toEqual([]);
    expect(scavengeToolCalls(complete, { allowedNames: new Set(["read_file"]) }).calls).toEqual([]);
  });

  it("does not scavenge JSON embedded in an edit replacement as another call", () => {
    const input = [
      "src/config.ts",
      "<<<<<<< SEARCH",
      "const x = {};",
      "=======",
      'const x = {"name":"search","arguments":{"q":"not a call"}};',
      ">>>>>>> REPLACE",
    ].join("\n");
    const r = scavengeToolCalls(input, {
      allowedNames: new Set(["edit_file", "search"]),
    });
    expect(r.calls).toHaveLength(1);
    expect(r.calls[0]!.function.name).toBe("edit_file");
  });
});
