// @vitest-environment jsdom

import { invoke } from "@tauri-apps/api/core";
import { openPath } from "@tauri-apps/plugin-opener";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openPath: vi.fn(), openUrl: vi.fn() }));

import { WorkspaceProvider } from "../Markdown";
import { DiffCard, SubagentCard, ToolCard } from "./cards";

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
    <WorkspaceProvider value={{ dir: "/repo", editor: "code" }}>
      <div>{ui}</div>
    </WorkspaceProvider>
  );
}

describe("ToolCard — open-in-editor button", () => {
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
    const btn = screen.getByRole("button", { name: "src/foo.ts:50" });
    expect(btn).toBeTruthy();

    fireEvent.click(btn);
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("open_in_editor", {
        command: "code",
        path: "/repo/src/foo.ts",
        line: 50,
      }),
    );
    expect(openPath).not.toHaveBeenCalled();
    // Clicking the action must not expand the card (it's outside the toggle button).
    expect(container.querySelector(".tool-call")).toBeNull();
  });

  it("shows the button for write_file args (no line → null)", async () => {
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
      expect(invoke).toHaveBeenCalledWith("open_in_editor", {
        command: "code",
        path: "/repo/src/new.ts",
        line: null,
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
});

describe("DiffCard — open-in-editor button", () => {
  it("renders the button in the header and opens at the first changed line", async () => {
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

    const btn = screen.getByRole("button", { name: "Open in editor" });
    expect(btn).toBeTruthy();

    fireEvent.click(btn);
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("open_in_editor", {
        command: "code",
        path: "/repo/src/foo.ts",
        line: 13,
      }),
    );
    expect(openPath).not.toHaveBeenCalled();
  });
});
