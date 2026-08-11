import { describe, expect, it } from "vitest";
import { projectSubagentEvent } from "../src/cli/commands/desktop.js";
import type { SubagentEvent } from "../src/tools/subagent.js";

function innerEvent(inner: NonNullable<SubagentEvent["inner"]>): SubagentEvent {
  return {
    kind: "inner",
    runId: "sub-1",
    task: "review changes",
    skillName: "review",
    model: "deepseek-v4-flash",
    inner,
  };
}

describe("desktop subagent progress projection", () => {
  it("projects lifecycle and monotonic counters", () => {
    expect(
      projectSubagentEvent({
        kind: "stream-progress",
        runId: "sub-1",
        task: "review changes",
        iter: 3,
        elapsedMs: 1200,
        outputChars: 40,
        reasoningChars: 80,
        toolReadChars: 160,
      }),
    ).toMatchObject({
      action: "stream",
      runId: "sub-1",
      iter: 3,
      elapsedMs: 1200,
      outputChars: 40,
      reasoningChars: 80,
      toolReadChars: 160,
    });
  });

  it("exposes redacted tool intent but never child reasoning or result bodies", () => {
    const start = projectSubagentEvent(
      innerEvent({
        turn: 1,
        role: "tool_start",
        content: "",
        reasoningDelta: "private chain of thought",
        callId: "call-1",
        toolName: "web_fetch",
        toolArgs: '{"authorization":"Bearer secret-token","url":"https://example.test"}',
      }),
    );
    expect(start).toMatchObject({
      action: "tool-start",
      childCallId: "call-1",
      toolName: "web_fetch",
    });
    expect(JSON.stringify(start)).not.toContain("private chain of thought");
    expect(JSON.stringify(start)).not.toContain("secret-token");

    const end = projectSubagentEvent(
      innerEvent({
        turn: 1,
        role: "tool",
        content: "sensitive tool result body",
        reasoningDelta: "more private reasoning",
        callId: "call-1",
        toolName: "web_fetch",
      }),
    );
    expect(end).toMatchObject({
      action: "tool-end",
      childCallId: "call-1",
      toolName: "web_fetch",
      toolOk: true,
    });
    expect(JSON.stringify(end)).not.toContain("sensitive tool result body");
    expect(JSON.stringify(end)).not.toContain("more private reasoning");
  });

  it("drops raw assistant events", () => {
    expect(
      projectSubagentEvent(
        innerEvent({
          turn: 1,
          role: "assistant_delta",
          content: "draft answer",
          reasoningDelta: "private reasoning",
        }),
      ),
    ).toBeNull();
  });
});
