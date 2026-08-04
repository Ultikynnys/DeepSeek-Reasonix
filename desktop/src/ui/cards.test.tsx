// @vitest-environment jsdom

import { invoke } from "@tauri-apps/api/core";
import { openPath } from "@tauri-apps/plugin-opener";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openPath: vi.fn(), openUrl: vi.fn() }));

import { WorkspaceProvider } from "../Markdown";
import { DiffCard, ToolCard } from "./cards";

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
