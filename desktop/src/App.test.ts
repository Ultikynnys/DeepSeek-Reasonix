import { describe, expect, it, vi } from "vitest";

vi.mock("./CommandPalette", () => ({
  CommandPalette: () => null,
  Toast: () => null,
  buildCommands: vi.fn(() => []),
  useCommandPalette: vi.fn(() => ({ open: false, setOpen: vi.fn() })),
}));
vi.mock("./Markdown", () => ({
  WorkspaceProvider: ({ children }: { children?: unknown }) => children ?? null,
}));
vi.mock("./theme", () => ({
  FONT_FAMILY: "sans-serif",
  FONT_FAMILY_STACK: "sans-serif",
  FONT_SCALE: 1,
  FONT_SCALE_ZOOM: 1,
  THEME: "dark",
  THEME_STYLE: {
    GRAPHITE: "graphite",
    SANDSTONE: "sandstone",
    PORCELAIN: "porcelain",
    MIDNIGHT: "midnight",
  },
  defaultStyleForTheme: vi.fn(() => ({
    bg: "#000",
    surface: "#111",
    border: "#222",
    text: "#fff",
    muted: "#888",
    accent: "#0af",
    danger: "#f00",
    warn: "#fa0",
    success: "#0f0",
    brand: "#0af",
  })),
  isFontFamily: vi.fn(() => true),
  isFontScale: vi.fn(() => true),
  isTheme: vi.fn(() => true),
  isThemeStyle: vi.fn(() => true),
  themeForStyle: vi.fn(() => "dark"),
}));

import { reduce } from "./App";
import type { ModelTurnStartedEvent } from "./protocol";
import { getThreadMaxWidth } from "./ui/thread-layout";

function initialState(): Parameters<typeof reduce>[0] {
  return {
    ready: false,
    needsSetup: false,
    busy: false,
    messages: [],
    pendingConfirms: [],
    pendingPathAccess: [],
    pendingChoices: [],
    pendingPlans: [],
    pendingCheckpoints: [],
    pendingRevisions: [],
    activePlan: null,
    usage: {
      totalCostUsd: 0,
      totalPromptTokens: 0,
      totalCompletionTokens: 0,
      cacheHitTokens: 0,
      cacheMissTokens: 0,
      lastCallCacheHit: null,
      lastCallCacheMiss: null,
      reservedTokens: 0,
      liveLogTokens: 0,
    },
    sessions: [],
    externalImportSources: [],
    settings: null,
    balance: null,
    codexQuota: null,
    codexQuotaRefreshing: false,
    codexQuotaReason: null,
    ollamaQuota: null,
    ollamaQuotaRefreshing: false,
    ollamaQuotaReason: null,
    mentionResults: null,
    mentionPreview: null,
    mcpSpecs: [],
    mcpBridged: false,
    skills: [],
    sessionFiles: [],
    memory: [],
    memoryDetail: null,
    memoryResult: null,
    memoryExport: null,
    jobs: [],
    activeSkill: null,
    queuedSends: [],
    retryNonce: 0,
    oauthWaiting: false,
    turnStatus: null,
    turnStatusTool: null,
    turnLastEventMs: 0,
    turnElapsedMs: 0,
  };
}

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
      { id: "always_allow", label: "Always allow", kind: "allow_always" },
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
    preview: `tool → ${path}`,
    meta: { sandboxRoot: "/workspace" },
    actions: [
      {
        id: "run_once",
        label: intent === "write" ? "Allow write" : "Allow read",
        kind: "allow_once",
      },
      { id: "always_allow", label: "Always allow", kind: "allow_always" },
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

describe("Desktop App reducer — usage", () => {
  it("falls back prompt tokens to cache miss tokens when cache fields are absent", () => {
    const next = reduce(initialState(), {
      t: "incoming",
      event: {
        type: "model.final",
        id: 1,
        ts: "2026-05-27T00:00:00.000Z",
        turn: 1,
        content: "ok",
        toolCalls: [],
        usage: { prompt_tokens: 1234, completion_tokens: 56, total_tokens: 1290 },
        costUsd: 0.001,
      },
    });

    expect(next.usage.totalPromptTokens).toBe(1234);
    expect(next.usage.cacheHitTokens).toBe(0);
    expect(next.usage.cacheMissTokens).toBe(1234);
    expect(next.usage.lastCallCacheMiss).toBe(1234);
  });

  it("settles the pending assistant message when an error ends the turn (#1660)", () => {
    const base = initialState();
    const state = {
      ...base,
      busy: true,
      messages: [
        ...base.messages,
        {
          kind: "assistant" as const,
          turn: 1,
          segments: [{ kind: "reasoning" as const, text: "thinking…" }],
          pending: true,
        },
      ],
    };
    const next = reduce(state, {
      t: "incoming",
      event: {
        type: "error",
        id: 1,
        ts: "2026-05-27T00:00:00.000Z",
        turn: 1,
        message: "SSE body read failed: terminated",
        recoverable: false,
      },
    });

    expect(next.busy).toBe(false);
    const assistant = next.messages.find((m) => m.kind === "assistant");
    expect(assistant?.pending).toBe(false);
    const error = next.messages.find((m) => m.kind === "error");
    expect(error?.message).toBe("SSE body read failed: terminated");
  });

  it("settles every unresolved tool card when the conversation stops", () => {
    const base = initialState();
    const state = {
      ...base,
      busy: true,
      messages: [
        {
          kind: "assistant" as const,
          turn: 1,
          segments: [
            {
              kind: "tool" as const,
              callId: "shell-1",
              name: "run_command",
              args: JSON.stringify({ command: "long task" }),
              startedAt: 100,
            },
            {
              kind: "tool" as const,
              callId: "review-1",
              name: "review",
              args: JSON.stringify({ task: "review changes" }),
              startedAt: 200,
            },
            {
              kind: "tool" as const,
              callId: "done-1",
              name: "read_file",
              args: JSON.stringify({ path: "README.md" }),
              startedAt: 300,
              result: "done",
              ok: true,
            },
          ],
          pending: true,
        },
      ],
    };

    const next = reduce(state, { t: "incoming", event: { type: "$turn_complete" } });

    expect(next.busy).toBe(false);
    const assistant = next.messages[0];
    expect(assistant?.kind).toBe("assistant");
    if (assistant?.kind !== "assistant") throw new Error("expected assistant message");
    expect(assistant.segments[0]).toMatchObject({
      callId: "shell-1",
      result: "Tool call cancelled because the conversation stopped. No result was produced.",
      ok: false,
    });
    expect(assistant.segments[1]).toMatchObject({
      callId: "review-1",
      result: "Tool call cancelled because the conversation stopped. No result was produced.",
      ok: false,
    });
    expect(assistant.segments[2]).toMatchObject({
      callId: "done-1",
      result: "done",
      ok: true,
    });

    const afterLateResult = reduce(next, {
      t: "incoming",
      event: {
        type: "tool.result",
        id: 99,
        ts: "2026-05-27T00:00:00.000Z",
        turn: 1,
        callId: "shell-1",
        output: "late success",
        ok: true,
      },
    });
    const afterAssistant = afterLateResult.messages[0];
    expect(afterAssistant?.kind).toBe("assistant");
    if (afterAssistant?.kind !== "assistant") throw new Error("expected assistant message");
    expect(afterAssistant.segments[0]).toMatchObject({
      result: "Tool call cancelled because the conversation stopped. No result was produced.",
      ok: false,
    });
  });

  it("keeps cumulative usage when live context breakdown refreshes", () => {
    const base = initialState();
    const next = reduce(
      {
        ...base,
        usage: {
          ...base.usage,
          cacheHitTokens: 80,
          cacheMissTokens: 20,
          totalPromptTokens: 100,
        },
      },
      {
        t: "incoming",
        event: { type: "$ctx_breakdown", reservedTokens: 10, logTokens: 42 },
      },
    );

    expect(next.usage.cacheHitTokens).toBe(80);
    expect(next.usage.cacheMissTokens).toBe(20);
    expect(next.usage.liveLogTokens).toBe(42);
  });
});

describe("Desktop App reducer — ApprovalPrompt integration", () => {
  it("stores shell confirm with prompt on $confirm_required", () => {
    const state = initialState();
    const prompt = makeShellPrompt("git status");
    const next = reduce(state, {
      t: "incoming",
      event: {
        type: "$confirm_required",
        id: 7,
        kind: "run_command",
        command: "git status",
        prompt,
      },
    });
    expect(next.pendingConfirms).toHaveLength(1);
    expect(next.pendingConfirms[0]).toMatchObject({
      id: 7,
      kind: "run_command",
      command: "git status",
    });
    expect(next.pendingConfirms[0].prompt).toEqual(prompt);
  });

  it("stores path access with prompt on $path_access_required", () => {
    const state = initialState();
    const prompt = makePathPrompt("/etc/passwd", "read");
    const next = reduce(state, {
      t: "incoming",
      event: {
        type: "$path_access_required",
        id: 8,
        path: "/etc/passwd",
        intent: "read",
        toolName: "read_file",
        sandboxRoot: "/workspace",
        allowPrefix: "/workspace",
        prompt,
      },
    });
    expect(next.pendingPathAccess).toHaveLength(1);
    expect(next.pendingPathAccess[0]).toMatchObject({
      id: 8,
      path: "/etc/passwd",
      intent: "read",
    });
    expect(next.pendingPathAccess[0].prompt).toEqual(prompt);
  });

  it("removes confirm on resolve_confirm", () => {
    const prompt = makeShellPrompt("ls");
    const state = {
      ...initialState(),
      pendingConfirms: [
        { id: 1, kind: "run_command" as const, command: "ls", prompt },
        {
          id: 2,
          kind: "run_command" as const,
          command: "pwd",
          prompt: { ...prompt, id: 2, subtitle: "pwd" },
        },
      ],
    };
    const next = reduce(state, { t: "resolve_confirm", id: 1 });
    expect(next.pendingConfirms).toHaveLength(1);
    expect(next.pendingConfirms[0].id).toBe(2);
  });

  it("removes path access on resolve_path_access", () => {
    const prompt = makePathPrompt("/tmp", "write");
    const state = {
      ...initialState(),
      pendingPathAccess: [
        {
          id: 3,
          path: "/tmp",
          intent: "write" as const,
          toolName: "write_file",
          sandboxRoot: "/workspace",
          allowPrefix: "/workspace",
          prompt,
        },
      ],
    };
    const next = reduce(state, { t: "resolve_path_access", id: 3 });
    expect(next.pendingPathAccess).toHaveLength(0);
  });

  it("clears all pending on clear action", () => {
    const shellPrompt = makeShellPrompt("echo hi");
    const pathPrompt = makePathPrompt("/x", "read");
    const state = {
      ...initialState(),
      pendingConfirms: [
        { id: 1, kind: "run_command" as const, command: "echo hi", prompt: shellPrompt },
      ],
      pendingPathAccess: [
        {
          id: 2,
          path: "/x",
          intent: "read" as const,
          toolName: "read_file",
          sandboxRoot: "/ws",
          allowPrefix: "/ws",
          prompt: pathPrompt,
        },
      ],
    };
    const next = reduce(state, { t: "clear" });
    expect(next.pendingConfirms).toHaveLength(0);
    expect(next.pendingPathAccess).toHaveLength(0);
  });

  it("patches settings optimistically for desktop setting commands", () => {
    const state: Parameters<typeof reduce>[0] = {
      ...initialState(),
      settings: {
        reasoningEffort: "medium",
        editMode: "review",
        budgetUsd: null,
        workspaceDir: "/workspace",
        recentWorkspaces: [],
        model: "deepseek-v4-flash",
        version: "0.50.1",
      },
    };

    const next = reduce(state, {
      t: "settings_patch",
      patch: { reasoningEffort: "low", editMode: "auto" },
    });

    expect(next.settings?.reasoningEffort).toBe("low");
    expect(next.settings?.editMode).toBe("auto");
  });
});

describe("Desktop App reducer — yolo interactive countdown", () => {
  it("stores countdownMs on pending choices when $choice_required carries it", () => {
    const next = reduce(initialState(), {
      t: "incoming",
      event: {
        type: "$choice_required",
        id: 8,
        question: "Which approach?",
        options: [
          { id: "option-1", title: "First" },
          { id: "option-2", title: "Second" },
        ],
        allowCustom: true,
        countdownMs: 10_000,
      },
    });
    expect(next.pendingChoices).toHaveLength(1);
    expect(next.pendingChoices[0]).toMatchObject({
      id: 8,
      countdownMs: 10_000,
    });
  });

  it("stores countdownMs on pending plans when $plan_required carries it", () => {
    const next = reduce(initialState(), {
      t: "incoming",
      event: {
        type: "$plan_required",
        id: 9,
        plan: "Step 1\nStep 2",
        steps: [{ id: "s1", title: "one", action: "edit" }],
        summary: "do it",
        countdownMs: 10_000,
      },
    });
    expect(next.pendingPlans).toHaveLength(1);
    expect(next.pendingPlans[0]).toMatchObject({
      id: 9,
      countdownMs: 10_000,
    });
  });

  it("leaves countdownMs undefined when $plan_required has none (review mode)", () => {
    const next = reduce(initialState(), {
      t: "incoming",
      event: { type: "$plan_required", id: 10, plan: "Step 1" },
    });
    expect(next.pendingPlans[0]?.countdownMs).toBeUndefined();
  });

  it("stores countdownMs on pending revisions when $revision_required carries it", () => {
    const next = reduce(initialState(), {
      t: "incoming",
      event: {
        type: "$revision_required",
        id: 11,
        reason: "scope changed",
        remainingSteps: [{ id: "s2", title: "two", action: "run" }],
        summary: "rev",
        countdownMs: 10_000,
      },
    });
    expect(next.pendingRevisions).toHaveLength(1);
    expect(next.pendingRevisions[0]).toMatchObject({
      id: 11,
      countdownMs: 10_000,
    });
  });
});

describe("desktop thread layout", () => {
  it("recomputes the thread cap from the latest viewport width", () => {
    const side = 244;
    const ctx = 320;

    expect(getThreadMaxWidth({ viewportWidth: 1000, visibleSide: side, visibleCtx: ctx })).toBe(
      580,
    );
    expect(getThreadMaxWidth({ viewportWidth: 1400, visibleSide: side, visibleCtx: ctx })).toBe(
      756,
    );
    expect(getThreadMaxWidth({ viewportWidth: 1800, visibleSide: side, visibleCtx: ctx })).toBe(
      1120,
    );
  });
});

describe("Desktop App reducer — compaction card lifecycle", () => {
  it("mounts a running compaction card on the last assistant message", () => {
    const state = {
      ...initialState(),
      messages: [
        { kind: "user" as const, text: "q1", clientId: "1", turn: 1 },
        {
          kind: "assistant" as const,
          turn: 1,
          segments: [{ kind: "text" as const, text: "answer" }],
          pending: false,
        },
      ],
    };
    const next = reduce(state, {
      t: "incoming",
      event: {
        type: "compaction.started",
        id: 1,
        ts: "2026-05-27T00:00:00.000Z",
        turn: 1,
        compactionId: "compaction-1",
        reason: "auto-context-pressure",
      },
    });
    const assistant = next.messages.find((m) => m.kind === "assistant");
    expect(assistant?.kind === "assistant" && assistant.segments.at(-1)).toMatchObject({
      kind: "compaction",
      id: "compaction-1",
      state: "running",
      reason: "auto-context-pressure",
    });
  });

  it("attaches the card to the LAST assistant message, not the first (#regression)", () => {
    const state = {
      ...initialState(),
      messages: [
        { kind: "user" as const, text: "q1", clientId: "1", turn: 1 },
        {
          kind: "assistant" as const,
          turn: 1,
          segments: [{ kind: "text" as const, text: "first answer" }],
          pending: false,
        },
        { kind: "user" as const, text: "q2", clientId: "2", turn: 2 },
        {
          kind: "assistant" as const,
          turn: 2,
          segments: [{ kind: "text" as const, text: "second answer" }],
          pending: false,
        },
      ],
    };
    const next = reduce(state, {
      t: "incoming",
      event: {
        type: "compaction.started",
        id: 1,
        ts: "2026-05-27T00:00:00.000Z",
        turn: 2,
        compactionId: "compaction-last",
        reason: "user",
      },
    });
    // The card must land on the message the user is looking at (the newest
    // assistant message) — attaching to the first assistant message buries it
    // at the top of the transcript where the compaction is invisible.
    const first = next.messages[1];
    const last = next.messages[3];
    expect(first?.kind === "assistant" && first.segments.length).toBe(1);
    expect(last?.kind === "assistant" && last.segments.at(-1)).toMatchObject({
      kind: "compaction",
      id: "compaction-last",
      state: "running",
    });
  });

  it("creates an assistant message when no assistant exists (idle /compact)", () => {
    const next = reduce(initialState(), {
      t: "incoming",
      event: {
        type: "compaction.started",
        id: 1,
        ts: "2026-05-27T00:00:00.000Z",
        turn: 3,
        compactionId: "compaction-u1",
        reason: "user",
      },
    });
    expect(next.messages).toHaveLength(1);
    expect(next.messages[0]?.kind).toBe("assistant");
    expect(next.messages[0]?.kind === "assistant" && next.messages[0].segments[0]).toMatchObject({
      kind: "compaction",
      id: "compaction-u1",
      state: "running",
      reason: "user",
    });
  });

  it("fills the card on compaction.finished — done state carries the fold numbers", () => {
    const state = {
      ...initialState(),
      messages: [
        {
          kind: "assistant" as const,
          turn: 1,
          segments: [
            {
              kind: "compaction" as const,
              id: "compaction-1",
              state: "running" as const,
              reason: "auto-context-pressure" as const,
            },
          ],
          pending: false,
        },
      ],
    };
    const next = reduce(state, {
      t: "incoming",
      event: {
        type: "compaction.finished",
        id: 2,
        ts: "2026-05-27T00:00:00.000Z",
        turn: 1,
        compactionId: "compaction-1",
        folded: true,
        beforeMessages: 243,
        afterMessages: 63,
        summaryChars: 2912,
        summary: "recap",
      },
    });
    const seg = next.messages[0]?.kind === "assistant" ? next.messages[0].segments[0] : undefined;
    expect(seg).toMatchObject({
      kind: "compaction",
      state: "done",
      beforeMessages: 243,
      afterMessages: 63,
      summaryChars: 2912,
      summary: "recap",
    });
  });

  it("marks the card failed when the fold reports an error, idle when nothing to fold", () => {
    const base = {
      ...initialState(),
      messages: [
        {
          kind: "assistant" as const,
          turn: 1,
          segments: [
            {
              kind: "compaction" as const,
              id: "c-1",
              state: "running" as const,
              reason: "user" as const,
            },
            {
              kind: "compaction" as const,
              id: "c-2",
              state: "running" as const,
              reason: "auto-context-pressure" as const,
            },
          ],
          pending: false,
        },
      ],
    };
    const next = reduce(base, {
      t: "incoming",
      event: {
        type: "compaction.finished",
        id: 3,
        ts: "2026-05-27T00:00:00.000Z",
        turn: 1,
        compactionId: "c-1",
        folded: false,
        beforeMessages: 12,
        afterMessages: 12,
        summaryChars: 0,
        error: "summary request timed out",
      },
    });
    const next2 = reduce(next, {
      t: "incoming",
      event: {
        type: "compaction.finished",
        id: 4,
        ts: "2026-05-27T00:00:00.000Z",
        turn: 1,
        compactionId: "c-2",
        folded: false,
        beforeMessages: 12,
        afterMessages: 12,
        summaryChars: 0,
      },
    });
    const segs = next2.messages[0]?.kind === "assistant" ? next2.messages[0].segments : [];
    expect(segs[0]).toMatchObject({
      kind: "compaction",
      id: "c-1",
      state: "failed",
      error: "summary request timed out",
    });
    expect(segs[1]).toMatchObject({ kind: "compaction", id: "c-2", state: "idle" });
  });
});

describe("Desktop App reducer — compaction file triage", () => {
  it("compaction.finished drops triaged files from sessionFiles", () => {
    const base = {
      ...initialState(),
      sessionFiles: [
        { path: "src/keep.ts", status: "c" as const },
        { path: "src/drop.ts", status: "c" as const },
        { path: "src/old.ts", status: "m" as const },
      ],
      messages: [
        {
          kind: "assistant" as const,
          turn: 1,
          segments: [
            {
              kind: "compaction" as const,
              id: "c-1",
              state: "running" as const,
              reason: "auto-context-pressure" as const,
            },
          ],
          pending: false,
        },
      ],
    };
    const next = reduce(base, {
      t: "incoming",
      event: {
        type: "compaction.finished",
        id: 2,
        ts: "2026-05-27T00:00:00.000Z",
        turn: 1,
        compactionId: "c-1",
        folded: true,
        beforeMessages: 243,
        afterMessages: 63,
        summaryChars: 2912,
        droppedFiles: ["src/drop.ts", "src/old.ts"],
      },
    });
    expect(next.sessionFiles).toEqual([{ path: "src/keep.ts", status: "c" }]);
    // The card segment records the dropped paths too (thread renders the meta).
    const seg = next.messages[0]?.kind === "assistant" ? next.messages[0].segments[0] : null;
    expect(seg).toMatchObject({
      kind: "compaction",
      state: "done",
      droppedFiles: ["src/drop.ts", "src/old.ts"],
    });
  });

  it("compaction.finished without drops leaves sessionFiles untouched", () => {
    const base = {
      ...initialState(),
      sessionFiles: [{ path: "src/a.ts", status: "c" as const }],
    };
    const next = reduce(base, {
      t: "incoming",
      event: {
        type: "compaction.finished",
        id: 2,
        ts: "2026-05-27T00:00:00.000Z",
        turn: 1,
        compactionId: "c-1",
        folded: true,
        beforeMessages: 5,
        afterMessages: 2,
        summaryChars: 100,
      },
    });
    expect(next.sessionFiles).toEqual([{ path: "src/a.ts", status: "c" }]);
  });

  it("$session_loaded excludes paths persisted in the files-dropped marker", () => {
    const base = initialState();
    const next = reduce(base, {
      t: "incoming",
      event: {
        type: "$session_loaded",
        name: "sess-1",
        messages: [
          {
            kind: "assistant",
            turn: 1,
            segments: [
              {
                kind: "text",
                text: "[compaction summary] recap\n\n<files-dropped-from-context>\nsrc/drop.ts\nsrc/old.ts\n</files-dropped-from-context>",
              },
              {
                kind: "tool",
                callId: "c1",
                name: "read_file",
                args: JSON.stringify({ path: "src/drop.ts" }),
              },
              {
                kind: "tool",
                callId: "c2",
                name: "read_file",
                args: JSON.stringify({ path: "src/keep.ts" }),
              },
            ],
            pending: false,
          },
        ],
        carryover: {
          totalCostUsd: 0,
          cacheHitTokens: 0,
          cacheMissTokens: 0,
          totalCompletionTokens: 0,
        },
      },
    });
    // The dropped paths would be re-derived from the surviving tool segment —
    // the marker keeps them out of the panel across reloads.
    expect(next.sessionFiles).toEqual([{ path: "src/keep.ts", status: "c" }]);
  });

  it("session.compacted swaps the chat to the post-fold conversation and re-derives files", () => {
    const base = {
      ...initialState(),
      // Pre-fold UI state: old conversation plus a running compaction card —
      // all of it must be replaced by the kernel's post-fold log.
      messages: [
        { kind: "user" as const, text: "q1", clientId: "1", turn: 1 },
        {
          kind: "assistant" as const,
          turn: 1,
          segments: [
            { kind: "text" as const, text: "answer" },
            {
              kind: "compaction" as const,
              id: "c-1",
              state: "done" as const,
              reason: "auto-context-pressure" as const,
              beforeMessages: 243,
              afterMessages: 63,
              summaryChars: 2912,
              summary: "recap",
            },
          ],
          pending: false,
        },
      ],
      sessionFiles: [
        { path: "src/keep.ts", status: "c" as const },
        { path: "src/stale.ts", status: "c" as const },
      ],
    };
    const next = reduce(base, {
      t: "incoming",
      event: {
        type: "session.compacted",
        id: 2,
        ts: "2026-05-27T00:00:00.000Z",
        turn: 1,
        beforeMessages: 243,
        afterMessages: 63,
        reason: "auto-context-pressure",
        // Wire shape matches $session_loaded.messages (server converts the
        // kernel ChatMessage log via buildLoadedMessages before emitting).
        replacementMessages: [
          {
            kind: "user",
            text: "q1",
          },
          {
            kind: "assistant",
            turn: 1,
            segments: [
              {
                kind: "text",
                text: "[CONVERSATION HISTORY SUMMARY — earlier turns folded for context efficiency]\n\nrecap\n\n<files-dropped-from-context>\nsrc/stale.ts\n</files-dropped-from-context>",
              },
            ],
            pending: false,
          },
          {
            kind: "user",
            text: "q2",
          },
          {
            kind: "assistant",
            turn: 2,
            segments: [
              { kind: "text", text: "kept tail answer" },
              {
                kind: "tool",
                callId: "c1",
                name: "read_file",
                args: JSON.stringify({ path: "src/keep.ts" }),
              },
            ],
            pending: false,
          },
        ],
      },
    });
    // The stale pre-fold conversation is gone; the folded summary message
    // (carrying the marker) renders as the compaction card in the thread.
    expect(next.messages).toHaveLength(4);
    const summary = next.messages[1];
    expect(summary?.kind === "assistant" && summary.segments[0]?.kind).toBe("text");
    // Files re-derived from the post-fold log, marker drops applied.
    expect(next.sessionFiles).toEqual([{ path: "src/keep.ts", status: "c" }]);
    expect(next.messages.at(-1)).toMatchObject({ kind: "assistant", turn: 2 });
  });
});

describe("Desktop App reducer — model.final content", () => {
  const turnStarted: ModelTurnStartedEvent = {
    type: "model.turn.started",
    id: 1,
    ts: "2026-05-27T00:00:00.000Z",
    turn: 1,
    model: "deepseek-v4-flash",
    reasoningEffort: "high",
    prefixHash: "h",
  };

  it("renders abort content when nothing streamed (no silent empty bubble)", () => {
    const state = reduce(initialState(), { t: "incoming", event: turnStarted });
    const next = reduce(state, {
      t: "incoming",
      event: {
        type: "model.final",
        id: 2,
        ts: "2026-05-27T00:00:00.000Z",
        turn: 1,
        content: "[aborted by user — no response produced.]",
        toolCalls: [],
        usage: {},
        costUsd: 0,
      },
    });
    const assistant = next.messages.find((m) => m.kind === "assistant");
    expect(assistant?.kind).toBe("assistant");
    if (assistant?.kind !== "assistant") return;
    expect(assistant.pending).toBe(false);
    expect(assistant.segments).toHaveLength(1);
    expect(assistant.segments[0]).toMatchObject({
      kind: "text",
      text: "[aborted by user — no response produced.]",
    });
  });

  it("does not duplicate content already streamed as deltas", () => {
    let state = reduce(initialState(), { t: "incoming", event: turnStarted });
    state = reduce(state, {
      t: "incoming",
      event: {
        type: "model.delta",
        id: 2,
        ts: "2026-05-27T00:00:00.000Z",
        turn: 1,
        channel: "content",
        text: "partial answer",
      },
    });
    const next = reduce(state, {
      t: "incoming",
      event: {
        type: "model.final",
        id: 3,
        ts: "2026-05-27T00:00:00.000Z",
        turn: 1,
        content: "partial answer",
        toolCalls: [],
        usage: {},
        costUsd: 0,
      },
    });
    const assistant = next.messages.find((m) => m.kind === "assistant");
    if (assistant?.kind !== "assistant") throw new Error("no assistant message");
    expect(assistant.segments).toHaveLength(1);
    expect(assistant.segments[0]).toMatchObject({ kind: "text", text: "partial answer" });
  });

  it("skips forcedSummary finals — the compaction card renders that content", () => {
    const state = reduce(initialState(), { t: "incoming", event: turnStarted });
    const next = reduce(state, {
      t: "incoming",
      event: {
        type: "model.final",
        id: 2,
        ts: "2026-05-27T00:00:00.000Z",
        turn: 1,
        content: "[aborted by user (Esc) — interrupted turn discarded. Ask again when ready.]",
        toolCalls: [],
        usage: {},
        costUsd: 0,
        forcedSummary: true,
      },
    });
    const assistant = next.messages.find((m) => m.kind === "assistant");
    if (assistant?.kind !== "assistant") throw new Error("no assistant message");
    expect(assistant.segments).toHaveLength(0);
    expect(assistant.pending).toBe(false);
  });
});

describe("Desktop App reducer — OpenAI OAuth flow state", () => {
  it("oauth_begin_result sets oauthWaiting", () => {
    const next = reduce(initialState(), {
      t: "incoming",
      event: { type: "oauth_begin_result", url: "https://auth.example/authorize?x=1" },
    });
    expect(next.oauthWaiting).toBe(true);
  });

  it("$error with an OAuth message clears oauthWaiting", () => {
    const state = { ...initialState(), oauthWaiting: true };
    const next = reduce(state, {
      t: "incoming",
      event: { type: "$error", message: "OAuth sign-in failed: access_denied" },
    });
    expect(next.oauthWaiting).toBe(false);
    expect(next.messages.at(-1)).toMatchObject({ kind: "error" });
  });

  it("unrelated $error keeps oauthWaiting", () => {
    const state = { ...initialState(), oauthWaiting: true };
    const next = reduce(state, {
      t: "incoming",
      event: { type: "$error", message: "settings_save failed: boom" },
    });
    expect(next.oauthWaiting).toBe(true);
  });

  it("$settings with signed-in OAuth clears oauthWaiting", () => {
    const state = { ...initialState(), oauthWaiting: true };
    const next = reduce(state, {
      t: "incoming",
      event: {
        type: "$settings",
        reasoningEffort: "medium",
        editMode: "review",
        budgetUsd: null,
        workspaceDir: "/workspace",
        recentWorkspaces: [],
        model: "gpt-5.6-sol",
        openaiOAuth: { signedIn: true, account: "u@example.com" },
        version: "0.50.1",
      },
    });
    expect(next.oauthWaiting).toBe(false);
    expect(next.settings?.openaiOAuth).toEqual({ signedIn: true, account: "u@example.com" });
  });

  it("$settings maps modelEndpoint and OAuth flowError into settings (#1529)", () => {
    const state = initialState();
    const next = reduce(state, {
      t: "incoming",
      event: {
        type: "$settings",
        reasoningEffort: "medium",
        editMode: "review",
        budgetUsd: null,
        workspaceDir: "/workspace",
        recentWorkspaces: [],
        model: "gpt-5.6-sol",
        modelEndpoint: {
          provider: "openai",
          baseUrl: "https://api.openai.com/v1",
          openaiAuth: "oauth",
          oauthAccount: "u@example.com",
        },
        openaiOAuth: {
          signedIn: true,
          account: "u@example.com",
          flowError: "OAuth token exchange failed: invalid_client",
        },
        version: "0.50.1",
      },
    });
    expect(next.settings?.modelEndpoint).toEqual({
      provider: "openai",
      baseUrl: "https://api.openai.com/v1",
      openaiAuth: "oauth",
      oauthAccount: "u@example.com",
    });
    expect(next.settings?.openaiOAuth).toEqual({
      signedIn: true,
      account: "u@example.com",
      flowError: "OAuth token exchange failed: invalid_client",
    });
  });

  it("$settings without signed-in OAuth keeps oauthWaiting", () => {
    const state = { ...initialState(), oauthWaiting: true };
    const next = reduce(state, {
      t: "incoming",
      event: {
        type: "$settings",
        reasoningEffort: "medium",
        editMode: "review",
        budgetUsd: null,
        workspaceDir: "/workspace",
        recentWorkspaces: [],
        model: "deepseek-v4-flash",
        version: "0.50.1",
      },
    });
    expect(next.oauthWaiting).toBe(true);
  });

  it("oauth_waiting action sets the flag directly (cancel button)", () => {
    const state = { ...initialState(), oauthWaiting: true };
    const next = reduce(state, { t: "oauth_waiting", waiting: false });
    expect(next.oauthWaiting).toBe(false);
  });
});

describe("Desktop App reducer — image attachments", () => {
  it("send_user with images attaches them to the optimistic user message", () => {
    const next = reduce(initialState(), {
      t: "send_user",
      text: "what does this show?",
      clientId: "c-img-1",
      images: ["data:image/png;base64,AAAA"],
    });
    const user = next.messages.find((m) => m.kind === "user");
    expect(user).toMatchObject({
      kind: "user",
      text: "what does this show?",
      clientId: "c-img-1",
      images: ["data:image/png;base64,AAAA"],
    });
  });

  it("send_user without images omits the images field", () => {
    const next = reduce(initialState(), { t: "send_user", text: "hi", clientId: "c-2" });
    const user = next.messages.find((m) => m.kind === "user");
    expect(user).toMatchObject({ kind: "user", text: "hi" });
    expect(user).not.toHaveProperty("images");
  });

  it("$session_loaded maps user images through to the thread", () => {
    const next = reduce(initialState(), {
      t: "incoming",
      event: {
        type: "$session_loaded",
        name: "sess-img",
        messages: [
          {
            kind: "user",
            text: "what does this show?",
            images: ["data:image/png;base64,AAAA"],
          },
          {
            kind: "assistant",
            turn: 1,
            segments: [{ kind: "text", text: "a chart" }],
            pending: false,
          },
        ],
        carryover: {
          totalCostUsd: 0,
          cacheHitTokens: 0,
          cacheMissTokens: 0,
          totalCompletionTokens: 0,
        },
      },
    });
    const user = next.messages.find((m) => m.kind === "user");
    expect(user).toMatchObject({
      kind: "user",
      text: "what does this show?",
      images: ["data:image/png;base64,AAAA"],
    });
  });
});

describe("Desktop App reducer — subagent progress", () => {
  it("associates parallel runs with their parent tool call ids", () => {
    const state = {
      ...initialState(),
      messages: [
        {
          kind: "assistant" as const,
          turn: 1,
          pending: true,
          segments: [
            {
              kind: "tool" as const,
              callId: "parent-a",
              name: "review",
              args: "{}",
              startedAt: 1,
            },
            {
              kind: "tool" as const,
              callId: "parent-b",
              name: "review",
              args: "{}",
              startedAt: 1,
            },
          ],
        },
      ],
    };
    const eventBase = {
      type: "subagent.progress" as const,
      id: 1,
      ts: "2026-06-01T00:00:00.000Z",
      turn: 1,
      action: "start" as const,
      task: "review",
    };
    const afterA = reduce(state, {
      t: "incoming",
      event: { ...eventBase, runId: "run-a", parentCallId: "parent-a" },
    });
    const afterB = reduce(afterA, {
      t: "incoming",
      event: { ...eventBase, id: 2, runId: "run-b", parentCallId: "parent-b" },
    });
    const assistant = afterB.messages[0];
    if (assistant?.kind !== "assistant") throw new Error("expected assistant");
    expect(assistant.segments[0]).toMatchObject({
      callId: "parent-a",
      subagentRuns: [{ runId: "run-a" }],
    });
    expect(assistant.segments[1]).toMatchObject({
      callId: "parent-b",
      subagentRuns: [{ runId: "run-b" }],
    });
  });

  it("pairs child tool activity and settles a failed run", () => {
    const base = {
      ...initialState(),
      messages: [
        {
          kind: "assistant" as const,
          turn: 2,
          pending: true,
          segments: [
            {
              kind: "tool" as const,
              callId: "parent",
              name: "explore",
              args: "{}",
              startedAt: 1,
            },
          ],
        },
      ],
    };
    const send = (
      state: Parameters<typeof reduce>[0],
      event: import("./protocol").SubagentProgressEvent,
    ) => reduce(state, { t: "incoming", event });
    const common = {
      type: "subagent.progress" as const,
      ts: "2026-06-01T00:00:00.000Z",
      turn: 2,
      runId: "run",
      parentCallId: "parent",
      task: "explore",
    };
    let state = send(base, { ...common, id: 1, action: "start" });
    state = send(state, {
      ...common,
      id: 2,
      action: "tool-start",
      childCallId: "child",
      toolName: "read_file",
    });
    state = send(state, {
      ...common,
      id: 3,
      action: "tool-end",
      childCallId: "child",
      toolOk: true,
    });
    state = send(state, { ...common, id: 4, action: "end", error: "failed" });
    const assistant = state.messages[0];
    if (assistant?.kind !== "assistant") throw new Error("expected assistant");
    expect(assistant.segments[0]).toMatchObject({
      subagentRuns: [
        {
          runId: "run",
          status: "failed",
          error: "failed",
          tools: [{ callId: "child", name: "read_file", status: "done" }],
        },
      ],
    });
  });
});

describe("Desktop App reducer — Ollama usage quota", () => {
  it("$ollama_quota stores the windows and clears the refresh flag", () => {
    const state = { ...initialState(), ollamaQuotaRefreshing: true };
    const next = reduce(state, {
      t: "incoming",
      event: {
        type: "$ollama_quota",
        quota: {
          session: { usagePct: 0.3, remainingPct: 99.7 },
          weekly: { usagePct: 0.1, remainingPct: 99.9 },
          turnUsedPct: 0.1,
          fetchedAt: 1234,
        },
      },
    });
    expect(next.ollamaQuota).toMatchObject({
      session: { usagePct: 0.3, remainingPct: 99.7 },
      weekly: { usagePct: 0.1, remainingPct: 99.9 },
      turnUsedPct: 0.1,
    });
    expect(next.ollamaQuotaRefreshing).toBe(false);
    expect(next.ollamaQuotaReason).toBeNull();
  });

  it("$ollama_quota with null quota carries the reason", () => {
    const next = reduce(initialState(), {
      t: "incoming",
      event: { type: "$ollama_quota", quota: null, reason: "usage-unavailable" },
    });
    expect(next.ollamaQuota).toBeNull();
    expect(next.ollamaQuotaReason).toBe("usage-unavailable");
    expect(next.ollamaQuotaRefreshing).toBe(false);
  });
});
