// @vitest-environment jsdom

import { invoke } from "@tauri-apps/api/core";
import { openPath } from "@tauri-apps/plugin-opener";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openPath: vi.fn(), openUrl: vi.fn() }));

import { WorkspaceProvider } from "../Markdown";
import {
  DiffCard,
  SubagentCard,
  ToolCard,
  extractSubagentResultMeta,
  isSubagentTool,
} from "./cards";

beforeAll(() => {
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText: vi.fn() },
    configurable: true,
  });
});

afterEach(() => {
  cleanup();
  vi.mocked(invoke).mockReset();
  vi.mocked(openPath).mockReset();
});

function wrap(ui: React.ReactNode) {
  return (
    <WorkspaceProvider value={{ dir: "/repo" }}>
      <div>{ui}</div>
    </WorkspaceProvider>
  );
}

describe("ToolCard — show-in-explorer button", () => {
  it("shows the button for read_file even while the card body is collapsed", async () => {
    const { container } = render(
      wrap(
        <ToolCard
          name="read_file"
          args={JSON.stringify({ path: "src/foo.ts", range: "50-100" })}
          result="…content…"
          ok
        />,
      ),
    );

    // ToolCard body starts collapsed (defaultOpen=false) — but the header
    // action must be visible regardless.
    expect(container.querySelector(".tool-call")).toBeNull();
    const btn = screen.getByRole("button", { name: "src/foo.ts" });
    expect(btn).toBeTruthy();

    fireEvent.click(btn);
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("reveal_in_explorer", {
        path: "/repo/src/foo.ts",
        workspace: "/repo",
      }),
    );
    expect(openPath).not.toHaveBeenCalled();
    // Clicking the action must not expand the card (it's outside the toggle button).
    expect(container.querySelector(".tool-call")).toBeNull();
  });

  it("shows the button for write_file args", async () => {
    render(
      wrap(
        <ToolCard
          name="write_file"
          args={JSON.stringify({ path: "src/new.ts", content: "…" })}
          result="ok"
          ok
        />,
      ),
    );

    const btn = screen.getByRole("button", { name: "src/new.ts" });
    expect(btn).toBeTruthy();

    fireEvent.click(btn);
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("reveal_in_explorer", {
        path: "/repo/src/new.ts",
        workspace: "/repo",
      }),
    );
  });

  it("shows no file button for non-file tools", () => {
    render(
      wrap(
        <ToolCard
          name="run_command"
          args={JSON.stringify({ command: "npm test" })}
          result="✓"
          ok
        />,
      ),
    );
    expect(screen.queryByRole("button", { name: /npm test/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /^src\// })).toBeNull();
  });

  it("shows the engine pill for web_search results", () => {
    render(
      wrap(
        <ToolCard
          name="web_search"
          args={JSON.stringify({ query: "flutter 3.19" })}
          result={"query: flutter 3.19\nengine: bing\nresults (2):\n1. One\n   https://one"}
          ok
        />,
      ),
    );

    const header = screen.getByRole("button", { name: /web_search/ });
    expect(header.textContent).toContain("bing");
  });

  it("shows the engine pill for web_fetch results too", () => {
    render(
      wrap(
        <ToolCard
          name="web_fetch"
          args={JSON.stringify({ url: "https://example.com/" })}
          result={"engine: ollama\n\nFetched\nhttps://example.com/\n\ncontent"}
          ok
        />,
      ),
    );

    const header = screen.getByRole("button", { name: /web_fetch/ });
    expect(header.textContent).toContain("ollama");
  });

  it("shows no engine pill when the result has no engine line", () => {
    const { container } = render(
      wrap(
        <ToolCard
          name="run_command"
          args={JSON.stringify({ command: "npm test" })}
          result="✓"
          ok
        />,
      ),
    );
    expect(container.querySelector(".pill-tag")).toBeNull();
  });
});

describe("SubagentCard — model visibility", () => {
  const run = {
    runId: "run-1",
    task: "Inspect quota rendering",
    skillName: "explore",
    model: "deepseek-v4-flash",
    status: "done" as const,
    contextTokens: 12_345,
    costUsd: 0.0123,
    tools: [],
  };

  it("shows the child model in the card header", () => {
    render(<SubagentCard name="explore" runs={[run]} />);

    const header = screen.getByRole("button", { name: /explore/ });
    expect(header.textContent).toContain("deepseek-v4-flash");
    expect(header.textContent).toContain("ctx 12.3k");
    expect(header.textContent).toContain("$0.0123");
  });

  it("updates context while running and hides cost until completion", () => {
    const { rerender } = render(
      <SubagentCard
        name="explore"
        runs={[{ ...run, status: "running", contextTokens: 8_000, costUsd: undefined }]}
      />,
    );

    let header = screen.getByRole("button", { name: /explore/ });
    expect(header.textContent).toContain("ctx 8.0k");
    expect(header.textContent).not.toContain("$");

    rerender(<SubagentCard name="explore" runs={[run]} />);
    header = screen.getByRole("button", { name: /explore/ });
    expect(header.textContent).toContain("ctx 12.3k");
    expect(header.textContent).toContain("$0.0123");
  });

  it("shows a provider quota % instead of a dollar figure for plan-billed runs", () => {
    render(
      <SubagentCard
        name="explore"
        runs={[
          {
            ...run,
            costUsd: 0,
            billingKind: "quota",
            quotaUsedPct: 2.5,
          },
        ]}
      />,
    );

    const header = screen.getByRole("button", { name: /explore/ });
    expect(header.textContent).toContain("2.50%");
    expect(header.textContent).not.toContain("$");
  });

  it("shows no cost metric when the run has no measurable billing", () => {
    render(
      <SubagentCard
        name="explore"
        runs={[{ ...run, costUsd: 0, billingKind: "none" }]}
      />,
    );
    const header = screen.getByRole("button", { name: /explore/ });
    expect(header.textContent).not.toContain("$");
    expect(header.textContent).not.toContain("%");
  });

  it("shows no cost metric when a quota run produced no measurable delta", () => {
    render(
      <SubagentCard
        name="explore"
        runs={[{ ...run, costUsd: 0, billingKind: "quota", quotaUsedPct: undefined }]}
      />,
    );
    const header = screen.getByRole("button", { name: /explore/ });
    expect(header.textContent).not.toContain("$");
    expect(header.textContent).not.toContain("%");
  });

  it("shows every distinct model for mixed-model fan-out", () => {
    render(
      <SubagentCard
        name="explore"
        runs={[
          run,
          {
            ...run,
            runId: "run-2",
            model: "deepseek-v4-pro",
            contextTokens: 24_680,
            costUsd: 0.02,
          },
        ]}
      />,
    );

    const header = screen.getByRole("button", { name: /explore/ });
    expect(header.textContent).toContain("deepseek-v4-flash + deepseek-v4-pro");
    expect(header.textContent).toContain("ctx 12.3k / 24.7k");
    expect(header.textContent).toContain("$0.0323");
  });

  it("renders subagent kind badge and markdown result in card body", () => {
    const { container } = render(
      <SubagentCard
        name="explore"
        runs={[run]}
        result="Found 3 references in `src/index.ts`."
        durationMs={2500}
      />,
    );

    const header = screen.getByRole("button", { name: /explore/ });
    expect(header.querySelector(".kind")?.textContent).toBe("subagent");
    expect(header.textContent).toContain("2.5s");

    const resultEl = container.querySelector(".subagent-result");
    expect(resultEl?.textContent).toContain("Found 3 references in src/index.ts.");
  });

  it("identifies subagent tool names correctly", () => {
    expect(isSubagentTool("explore")).toBe(true);
    expect(isSubagentTool("research")).toBe(true);
    expect(isSubagentTool("review")).toBe(true);
    expect(isSubagentTool("security_review")).toBe(true);
    expect(isSubagentTool("security-review")).toBe(true);
    expect(isSubagentTool("spawn_subagent")).toBe(true);
    expect(isSubagentTool("run_skill", JSON.stringify({ name: "explore" }))).toBe(true);
    expect(isSubagentTool("read_file")).toBe(false);
    expect(isSubagentTool("run_command")).toBe(false);
  });

  it("recovers model and cost from the persisted result envelope", () => {
    expect(
      extractSubagentResultMeta(
        JSON.stringify({
          success: true,
          output: "…",
          turns: 6,
          elapsed_ms: 25223,
          cost_usd: 0.0062,
          model: "deepseek-v4-flash",
          billing_kind: "usd",
        }),
      ),
    ).toEqual({
      costUsd: 0.0062,
      model: "deepseek-v4-flash",
      billingKind: "usd",
      elapsedMs: 25223,
      turns: 6,
    });

    // quota-billed run
    expect(
      extractSubagentResultMeta(
        JSON.stringify({ cost_usd: 0, billing_kind: "quota", quota_used_pct: 2.5 }),
      ),
    ).toEqual({ costUsd: 0, billingKind: "quota", quotaUsedPct: 2.5 });

    expect(extractSubagentResultMeta("not json")).toEqual({});
    expect(extractSubagentResultMeta(undefined)).toEqual({});
  });

  it("shows model and cost on a result-only run (no subagentRuns after reload)", () => {
    render(
      <SubagentCard
        name="explore"
        runs={[
          {
            runId: "run-1",
            task: "Inspect quota rendering",
            skillName: "explore",
            model: "deepseek-v4-flash",
            status: "done",
            costUsd: 0.0422,
            billingKind: "usd",
            tools: [],
          },
        ]}
      />,
    );

    const header = screen.getByRole("button", { name: /explore/ });
    expect(header.textContent).toContain("deepseek-v4-flash");
    expect(header.textContent).toContain("$0.0422");
  });

  it("shows the last 3 rows of thinking and process when subagent is running", () => {
    const runningRun = {
      runId: "run-live",
      task: "Analyze codebase",
      skillName: "explore",
      model: "deepseek-v4-flash",
      status: "running" as const,
      tools: [],
      recentRows: [
        { id: "r1", kind: "thinking" as const, text: "Initial thoughts" },
        { id: "r2", kind: "process" as const, text: "↳ read_file src/index.ts" },
        { id: "r3", kind: "thinking" as const, text: "Parsing export signatures" },
        { id: "r4", kind: "process" as const, text: "↳ search_content loop" },
      ],
    };

    render(<SubagentCard name="explore" runs={[runningRun]} />);

    const activityBox = screen.getByLabelText("Subagent activity");
    expect(activityBox).toBeTruthy();

    const rows = activityBox.querySelectorAll(".sub-activity-row");
    expect(rows.length).toBe(3);

    // Should show the last 3 rows (r2, r3, r4), dropping r1
    expect(rows[0]?.textContent).toContain("process");
    expect(rows[0]?.textContent).toContain("↳ read_file src/index.ts");
    expect(rows[1]?.textContent).toContain("thinking");
    expect(rows[1]?.textContent).toContain("Parsing export signatures");
    expect(rows[2]?.textContent).toContain("process");
    expect(rows[2]?.textContent).toContain("↳ search_content loop");
  });
});

describe("DiffCard — show-in-explorer button", () => {
  it("renders the button in the header and reveals the file in the explorer", async () => {
    render(
      wrap(
        <DiffCard
          filename="src/foo.ts"
          applied
          lines={[
            { t: "hunk", s: "@@ -12,3 +12,3 @@" },
            { t: "ctx", l: 12, r: 12, s: "const a = 1;" },
            { t: "rm", l: 13, s: "const b = 2;" },
            { t: "add", r: 13, s: "const b = 3;" },
          ]}
        />,
      ),
    );

    const btn = screen.getByRole("button", { name: "Show in file explorer" });
    expect(btn).toBeTruthy();

    fireEvent.click(btn);
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("reveal_in_explorer", {
        path: "/repo/src/foo.ts",
        workspace: "/repo",
      }),
    );
    expect(openPath).not.toHaveBeenCalled();
  });

  it("right-click exposes an Open-with… menu that fires open_with_dialog", async () => {
    render(
      wrap(
        <ToolCard
          name="read_file"
          args={JSON.stringify({ path: "src/foo.ts", range: "1-10" })}
          result="…content…"
          ok
        />,
      ),
    );

    const btn = screen.getByRole("button", { name: "src/foo.ts" });
    fireEvent.contextMenu(btn);

    const openWith = await screen.findByRole("menuitem", { name: "Open with…" });
    expect(openWith).toBeTruthy();
    expect(invoke).not.toHaveBeenCalledWith("open_with_dialog", expect.anything());

    fireEvent.click(openWith);
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("open_with_dialog", {
        path: "/repo/src/foo.ts",
      }),
    );
  });

  it("right-click menu also offers Copy path and copies the resolved absolute path", async () => {
    render(
      wrap(
        <ToolCard
          name="write_file"
          args={JSON.stringify({ path: "src/new.ts", content: "…" })}
          result="ok"
          ok
        />,
      ),
    );

    const btn = screen.getByRole("button", { name: "src/new.ts" });
    fireEvent.contextMenu(btn);

    const copyPath = await screen.findByRole("menuitem", { name: "Copy path" });
    fireEvent.click(copyPath);
    await waitFor(() =>
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith("/repo/src/new.ts"),
    );
  });
});
