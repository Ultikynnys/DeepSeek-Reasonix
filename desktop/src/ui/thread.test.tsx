// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./cards", () => ({
  AssistantText: () => null,
  PlanCardView: () => null,
  ShellCard: () => null,
  ToolCard: () => null,
  ReasoningCard: () => null,
}));

import { ConfirmApprovalCard, PathAccessApprovalCard } from "./thread";

function makeShellPrompt(command: string): import("@reasonix/core-utils").ApprovalPrompt {
  return {
    id: 1,
    kind: "shell",
    tone: "warn",
    title: "Run command",
    subtitle: command,
    preview: command,
    meta: {},
    actions: [
      { id: "run_once", label: "Run once", kind: "allow_once" },
      { id: "always_allow", label: "Always allow — git", kind: "allow_always" },
      {
        id: "deny",
        label: "Deny",
        kind: "reject",
        secondaryInput: { hint: "Reason", required: false },
      },
    ],
    data: { prefix: command.split(" ")[0] ?? "" },
  };
}

function makePathPrompt(
  path: string,
  intent: "read" | "write",
): import("@reasonix/core-utils").ApprovalPrompt {
  return {
    id: 2,
    kind: "path",
    tone: "warn",
    title: `Access path — ${intent}`,
    subtitle: path,
    preview: `read_file → ${path}`,
    meta: { sandboxRoot: "/workspace" },
    actions: [
      {
        id: "run_once",
        label: intent === "write" ? "Allow write" : "Allow read",
        kind: "allow_once",
      },
      { id: "always_allow", label: "Always allow — /workspace", kind: "allow_always" },
      {
        id: "deny",
        label: "Deny",
        kind: "reject",
        secondaryInput: { hint: "Reason", required: false },
      },
    ],
    data: { prefix: "/workspace", intent },
  };
}

afterEach(cleanup);

describe("ConfirmApprovalCard — ApprovalPrompt rendering", () => {
  it("renders immutable Outlook send details without an always-allow action", () => {
    const prompt: import("@reasonix/core-utils").ApprovalPrompt = {
      id: 3,
      kind: "email",
      tone: "error",
      title: "Confirm Outlook email send",
      subtitle: "sender@outlook.com → recipient@example.com",
      preview: "Complete application body",
      meta: {
        From: "sender@outlook.com",
        To: "recipient@example.com",
        Cc: "copy@example.com",
        Bcc: "hidden@example.com",
        Subject: "Application",
        Attachments: "CV.pdf",
      },
      actions: [
        { id: "run_once", label: "Send this email", kind: "allow_once" },
        { id: "deny", label: "Cancel send", kind: "reject" },
      ],
    };
    const { container } = render(
      <ConfirmApprovalCard
        prompt={prompt}
        onAllow={() => {}}
        onAlwaysAllow={() => {}}
        onDeny={() => {}}
      />,
    );
    expect(container.textContent).toContain("From: sender@outlook.com");
    expect(container.textContent).toContain("To: recipient@example.com");
    expect(container.textContent).toContain("Bcc: hidden@example.com");
    expect(container.textContent).toContain("Subject: Application");
    expect(container.textContent).toContain("Complete application body");
    expect(container.textContent).toContain("Attachments: CV.pdf");
    expect(screen.getByRole("button", { name: "Send this email" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Cancel send" })).toBeTruthy();
    expect(screen.queryByText(/Always allow/)).toBeNull();
  });

  it("renders title, subtitle, and action buttons from prompt", () => {
    const { container } = render(
      <ConfirmApprovalCard
        prompt={makeShellPrompt("git status")}
        onAllow={() => {}}
        onAlwaysAllow={() => {}}
        onDeny={() => {}}
      />,
    );
    expect(container.querySelector(".ap-title")?.textContent).toBe("Run command");
    expect(container.querySelector(".ap-sub")?.textContent).toBe("git status");
    expect(screen.getByRole("button", { name: "Run once" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Always allow — git" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Deny" })).toBeTruthy();
  });

  it("fires onAllow when primary button is clicked", () => {
    const onAllow = vi.fn();
    render(
      <ConfirmApprovalCard
        prompt={makeShellPrompt("echo hi")}
        onAllow={onAllow}
        onAlwaysAllow={() => {}}
        onDeny={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Run once" }));
    expect(onAllow).toHaveBeenCalledTimes(1);
  });

  it("fires onAlwaysAllow with prefix when tertiary button is clicked", () => {
    const onAlwaysAllow = vi.fn();
    render(
      <ConfirmApprovalCard
        prompt={makeShellPrompt("npm test")}
        onAllow={() => {}}
        onAlwaysAllow={onAlwaysAllow}
        onDeny={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Always allow/ }));
    expect(onAlwaysAllow).toHaveBeenCalledTimes(1);
    expect(onAlwaysAllow).toHaveBeenCalledWith("npm");
  });

  it("fires onDeny when secondary button is clicked", () => {
    const onDeny = vi.fn();
    render(
      <ConfirmApprovalCard
        prompt={makeShellPrompt("rm -rf /")}
        onAllow={() => {}}
        onAlwaysAllow={() => {}}
        onDeny={onDeny}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Deny" }));
    expect(onDeny).toHaveBeenCalledTimes(1);
  });
});

describe("PathAccessApprovalCard — ApprovalPrompt rendering", () => {
  it("renders title, subtitle, and action buttons from prompt", () => {
    const { container } = render(
      <PathAccessApprovalCard
        prompt={makePathPrompt("/etc/passwd", "read")}
        onAllow={() => {}}
        onAlwaysAllow={() => {}}
        onDeny={() => {}}
      />,
    );
    expect(container.querySelector(".ap-title")?.textContent).toBe("Access path — read");
    expect(container.querySelector(".ap-sub")?.textContent).toBe("/etc/passwd");
    expect(screen.getByRole("button", { name: "Allow read" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Deny" })).toBeTruthy();
  });

  it("fires onAlwaysAllow with prefix for path access", () => {
    const onAlwaysAllow = vi.fn();
    render(
      <PathAccessApprovalCard
        prompt={makePathPrompt("/tmp", "write")}
        onAllow={() => {}}
        onAlwaysAllow={onAlwaysAllow}
        onDeny={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Always allow/ }));
    expect(onAlwaysAllow).toHaveBeenCalledTimes(1);
    expect(onAlwaysAllow).toHaveBeenCalledWith("/workspace");
  });
});
