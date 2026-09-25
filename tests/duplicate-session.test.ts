import { describe, expect, it } from "vitest";
import {
  DUPLICATE_SESSION_INSTRUCTION,
  buildDuplicateContext,
  truncateMarkdownToTokens,
  truncateToolOutputsInMarkdown,
} from "../src/duplicate-session.js";
import { countTokens } from "../src/tokenizer.js";

const SEP = "\n\n---\n\n";

describe("truncateMarkdownToTokens", () => {
  it("returns the transcript unchanged when it fits the budget", () => {
    const md = `### You${SEP}hello${SEP}### Reasonix${SEP}hi`;
    const r = truncateMarkdownToTokens(md, 100_000);
    expect(r.text).toBe(md);
    expect(r.truncated).toBe(false);
    expect(r.droppedTokens).toBe(0);
  });

  it("empties the blob at a zero/negative budget", () => {
    const r = truncateMarkdownToTokens("### You\n\nhello", 0);
    expect(r.text).toBe("");
    expect(r.truncated).toBe(true);
    expect(r.droppedTokens).toBeGreaterThan(0);
  });

  it("handles empty input", () => {
    expect(truncateMarkdownToTokens("", 100)).toEqual({
      text: "",
      droppedTokens: 0,
      truncated: false,
    });
  });

  it("keeps the newest blocks and drops the oldest when over budget", () => {
    const oldest = `HEAD-ONLY-MARKER ${"word ".repeat(2000)}`;
    const newest = `### Reasonix${SEP}the newest message stays`;
    const md = `### You${SEP}${oldest}${SEP}${newest}`;
    const budget = 60; // the newest block fits; the huge oldest block does not
    const r = truncateMarkdownToTokens(md, budget);
    expect(r.truncated).toBe(true);
    expect(r.text).toContain("the newest message stays");
    expect(r.text).not.toContain("HEAD-ONLY-MARKER");
    expect(countTokens(r.text)).toBeLessThanOrEqual(budget + 5);
  });

  it("tail-truncates the oldest retained block to fill the remaining budget", () => {
    const oldest = `HEAD-ONLY-MARKER ${"filler ".repeat(5000)}`;
    const newest = `### Reasonix${SEP}${"tail ".repeat(50)}NEWEST-TAIL-SENTINEL`;
    const md = `${oldest}${SEP}${newest}`;
    const r = truncateMarkdownToTokens(md, 200);
    expect(r.text).toContain("NEWEST-TAIL-SENTINEL");
    // The oldest block's head is dropped; only its tail survives.
    expect(r.text).not.toContain("HEAD-ONLY-MARKER");
    expect(countTokens(r.text)).toBeLessThanOrEqual(210);
  });
});

describe("buildDuplicateContext", () => {
  it("appends the continuation instruction and a truncation header", () => {
    const md = `### You${SEP}${"x ".repeat(4000)}${SEP}### Reasonix${SEP}latest`;
    const out = buildDuplicateContext(md, 60);
    expect(out).toContain(DUPLICATE_SESSION_INSTRUCTION);
    expect(out).toContain("Truncated continuation context");
    expect(out).toContain("latest");
  });

  it("omits the truncation header when nothing was dropped", () => {
    const out = buildDuplicateContext("### You\n\nsmall session", 100_000);
    expect(out).not.toContain("Truncated continuation context");
    expect(out).toContain(DUPLICATE_SESSION_INSTRUCTION);
  });

  it("truncates bloated command outputs to 3 lines max per card output while keeping thinking intact", () => {
    const bloatedTool = [
      "> **Tool · `run_command`**",
      "",
      "```json",
      '{"command": "git log"}',
      "```",
      "",
      "```",
      "commit 1",
      "commit 2",
      "commit 3",
      "commit 4",
      "commit 5",
      "commit 6",
      "```",
    ].join("\n");

    const thinking = [
      "<details>",
      "<summary>Thought process</summary>",
      "",
      "Line 1 of reasoning",
      "Line 2 of reasoning",
      "Line 3 of reasoning",
      "Line 4 of reasoning",
      "Line 5 of reasoning",
      "",
      "</details>",
    ].join("\n");

    const md = `### You\n\nRun git log please\n\n---\n\n### Reasonix\n\n${thinking}\n\n${bloatedTool}\n\nDone!`;
    const out = buildDuplicateContext(md, 50_000);

    // Command output is capped at 3 lines
    expect(out).toContain("commit 1\ncommit 2\ncommit 3\n```");
    expect(out).not.toContain("commit 4");
    expect(out).not.toContain("commit 5");

    // All thinking and user input are completely preserved
    expect(out).toContain("Run git log please");
    expect(out).toContain("Line 1 of reasoning");
    expect(out).toContain("Line 2 of reasoning");
    expect(out).toContain("Line 3 of reasoning");
    expect(out).toContain("Line 4 of reasoning");
    expect(out).toContain("Line 5 of reasoning");
  });

  it("leaves tool outputs with 3 or fewer lines unchanged", () => {
    const shortTool = ["> **Tool · `run_command`**", "", "```", "line A", "line B", "```"].join(
      "\n",
    );

    const out = truncateToolOutputsInMarkdown(shortTool, 3);
    expect(out).toContain("line A\nline B");
  });

  it("does not truncate code blocks outside of tool blocks", () => {
    const codeBlock = [
      "Here is the script:",
      "",
      "```typescript",
      "const a = 1;",
      "const b = 2;",
      "const c = 3;",
      "const d = 4;",
      "const e = 5;",
      "```",
    ].join("\n");

    const out = truncateToolOutputsInMarkdown(codeBlock, 3);
    expect(out).toContain("const a = 1;\nconst b = 2;\nconst c = 3;\nconst d = 4;\nconst e = 5;");
  });
});
