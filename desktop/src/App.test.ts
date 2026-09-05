import { describe, expect, it, vi } from "vitest";

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

import {
  activePlanForMessage,
  hasPendingIntervention,
  parseSessionTimestamp,
  reduce,
  sessionRecency,
  sortSessionsDescending,
} from "./App";
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
      lastCallCostUsd: 0,
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
    antigravityQuota: null,
    antigravityQuotaRefreshing: false,
    antigravityQuotaReason: null,
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
    antigravityOAuthWaiting: false,
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
    const error = next.messages.find((m) => m.kind === "notice" && m.severity === "error");
    expect(error).toMatchObject({
      kind: "notice",
      text: "SSE body read failed: terminated",
      severity: "error",
    });
  });

  it("anchors a late kernel error to its turn instead of the bottom of the timeline", () => {
    const base = initialState();
    const state = {
      ...base,
      messages: [
        { kind: "user" as const, text: "first", clientId: "c-1", turn: 1 },
        { kind: "assistant" as const, turn: 1, segments: [], pending: false },
        { kind: "user" as const, text: "second", clientId: "c-2", turn: 2 },
        { kind: "assistant" as const, turn: 2, segments: [], pending: false },
      ],
    };
    const next = reduce(state, {
      t: "incoming",
      event: {
        type: "error",
        id: 3,
        ts: "2026-05-27T00:00:00.000Z",
        turn: 1,
        message: "Late failure from turn one",
        recoverable: false,
      },
    });

    expect(
      next.messages.map((m) => (m.kind === "notice" ? `notice-${m.turn}` : `${m.kind}-${m.turn}`)),
    ).toEqual(["user-1", "assistant-1", "notice-1", "user-2", "assistant-2"]);
  });

  it("places an error before later turns when its own turn messages are absent", () => {
    const base = initialState();
    const state = {
      ...base,
      messages: [
        { kind: "user" as const, text: "second", clientId: "c-2", turn: 2 },
        { kind: "assistant" as const, turn: 2, segments: [], pending: false },
      ],
    };
    const next = reduce(state, {
      t: "incoming",
      event: {
        type: "error",
        id: 4,
        ts: "2026-05-27T00:00:00.000Z",
        turn: 1,
        message: "Failure from a missing earlier turn",
        recoverable: false,
      },
    });

    expect(
      next.messages.map((m) => (m.kind === "notice" ? `notice-${m.turn}` : `${m.kind}-${m.turn}`)),
    ).toEqual(["notice-1", "user-2", "assistant-2"]);
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

  it("stores the per-tab subagent model from $settings and settings_patch", () => {
    // Each tab has its own reducer state — this locks in that the subagent
    // model is a per-tab field (not global), so different tabs can hold
    // different main/subagent model combinations.
    const fromEvent = reduce(initialState(), {
      t: "incoming",
      event: {
        type: "$settings",
        reasoningEffort: "high",
        editMode: "review",
        quickSendId: "proceed",
        quickSends: [],
        budgetUsd: null,
        workspaceDir: "/workspace",
        recentWorkspaces: [],
        model: "deepseek-v4-pro",
        subagentModel: "deepseek-v4-flash",
        version: "0.50.1",
      },
    });
    expect(fromEvent.settings?.model).toBe("deepseek-v4-pro");
    expect(fromEvent.settings?.subagentModel).toBe("deepseek-v4-flash");
    // The active quick-send id and custom list must survive the $settings
    // round-trip, or the Settings → General selector can never highlight a
    // choice (regression: quick-send enum was dropped from the reducer).
    expect(fromEvent.settings?.quickSendId).toBe("proceed");
    expect(fromEvent.settings?.quickSends).toEqual([]);

    // An explicit chat-menu pick patches the tab's own subagent model.
    const base: Parameters<typeof reduce>[0] = {
      ...initialState(),
      settings: {
        reasoningEffort: "high",
        editMode: "review",
        budgetUsd: null,
        workspaceDir: "/workspace",
        recentWorkspaces: [],
        model: "deepseek-v4-flash",
        version: "0.50.1",
      },
    };
    const patched = reduce(base, {
      t: "settings_patch",
      patch: { subagentModel: "gpt-5.6-sol" },
    });
    expect(patched.settings?.subagentModel).toBe("gpt-5.6-sol");

    // Absent subagentModel = subagents follow the main model.
    const noOverride = reduce(initialState(), {
      t: "incoming",
      event: {
        type: "$settings",
        reasoningEffort: "high",
        editMode: "review",
        quickSendId: "proceed",
        quickSends: [],
        budgetUsd: null,
        workspaceDir: "/workspace",
        recentWorkspaces: [],
        model: "deepseek-v4-pro",
        version: "0.50.1",
      },
    });
    expect(noOverride.settings?.subagentModel).toBeUndefined();
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

  it("transitions turnStatus to waiting_user and updates hasPendingIntervention on $choice_required", () => {
    const s0 = { ...initialState(), busy: true, turnStatus: "calling_tool" as const };
    const next = reduce(s0, {
      t: "incoming",
      event: {
        type: "$choice_required",
        id: 12,
        question: "A or B?",
        options: [
          { id: "A", title: "Option A" },
          { id: "B", title: "Option B" },
        ],
        allowCustom: true,
      },
    });
    expect(next.turnStatus).toBe("waiting_user");
    expect(hasPendingIntervention(next)).toBe(true);

    const resolved = reduce(next, { t: "resolve_choice", id: 12 });
    expect(hasPendingIntervention(resolved)).toBe(false);
    expect(resolved.turnStatus).toBe("calling_tool");
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

  it("session.compacted preserves the live chat transcript and re-derives files", () => {
    const base = {
      ...initialState(),
      // Pre-fold UI state: old conversation plus a compaction card at turn 1.
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
    // The live chat transcript is preserved with its compaction card in place.
    expect(next.messages).toEqual(base.messages);
    // Files re-derived from the post-fold log, marker drops applied.
    expect(next.sessionFiles).toEqual([{ path: "src/keep.ts", status: "c" }]);
  });
});

describe("Desktop App reducer — $session_loaded resync echo", () => {
  function loaded(session: string, resync: boolean): Parameters<typeof reduce>[1] {
    return {
      t: "incoming",
      event: {
        type: "$session_loaded",
        name: session,
        resync,
        messages: [
          { kind: "user", text: "q1" },
          {
            kind: "assistant",
            turn: 1,
            segments: [{ kind: "text", text: "a1" }],
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
    };
  }

  it("skips a resync echo of the already-loaded session, even when idle", () => {
    const base = {
      ...initialState(),
      busy: false,
      currentSession: "sess-1",
      messages: [{ kind: "user" as const, text: "live", clientId: "c", turn: 1 }],
    };
    // Cold-start double-emit: bootstrap $session_loaded already applied, then
    // desktop_resync echoes the same session. Must NOT wipe the transcript.
    const next = reduce(base, loaded("sess-1", true));
    expect(next.messages).toEqual([{ kind: "user", text: "live", clientId: "c", turn: 1 }]);
    expect(next.currentSession).toBe("sess-1");
  });

  it("applies a resync echo when the session differs (genuine reload)", () => {
    const base = { ...initialState(), currentSession: "sess-1" };
    const next = reduce(base, loaded("sess-2", true));
    expect(next.currentSession).toBe("sess-2");
    expect(next.messages).toHaveLength(2);
  });

  it("applies a non-resync session load (user-initiated switch)", () => {
    const base = { ...initialState(), currentSession: "sess-1" };
    const next = reduce(base, loaded("sess-2", false));
    expect(next.currentSession).toBe("sess-2");
    expect(next.messages).toHaveLength(2);
  });
});

describe("Desktop App session sorting", () => {
  it("parseSessionTimestamp extracts millisecond timestamp and sessionRecency computes max", () => {
    expect(parseSessionTimestamp("desktop-20260905120000-1")).toBe(Date.UTC(2026, 8, 5, 12, 0, 0));
    expect(parseSessionTimestamp("plain-session")).toBe(0);

    const recency = sessionRecency({
      name: "desktop-20260905120000-1",
      messageCount: 0,
      mtime: new Date(Date.UTC(2026, 8, 5, 10, 0, 0)).toISOString(),
    });
    expect(recency).toBe(Date.UTC(2026, 8, 5, 12, 0, 0));
  });

  it("sortSessionsDescending prioritizes newest sessions by recency and tie-breaks by name", () => {
    const list = [
      { name: "desktop-20260901100000-1", messageCount: 2, mtime: new Date(1000).toISOString() },
      { name: "desktop-20260905120000-1", messageCount: 0, mtime: new Date(1000).toISOString() },
      { name: "desktop-20260903110000-1", messageCount: 5, mtime: new Date(1000).toISOString() },
    ];
    const sorted = [...list].sort(sortSessionsDescending);
    expect(sorted.map((s) => s.name)).toEqual([
      "desktop-20260905120000-1",
      "desktop-20260903110000-1",
      "desktop-20260901100000-1",
    ]);
  });

  it("reducer applies sortSessionsDescending on incoming $sessions event", () => {
    const state = initialState();
    const next = reduce(state, {
      t: "incoming",
      event: {
        type: "$sessions",
        items: [
          {
            name: "desktop-20260901100000-1",
            messageCount: 2,
            mtime: new Date(1000).toISOString(),
          },
          {
            name: "desktop-20260905120000-1",
            messageCount: 0,
            mtime: new Date(1000).toISOString(),
          },
        ],
      },
    });
    expect(next.sessions[0]?.name).toBe("desktop-20260905120000-1");
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

  it("appends an image segment when model.final carries an image", () => {
    const state = reduce(initialState(), { t: "incoming", event: turnStarted });
    const next = reduce(state, {
      t: "incoming",
      event: {
        type: "model.final",
        id: 3,
        ts: "2026-05-27T00:00:00.000Z",
        turn: 1,
        content: "",
        toolCalls: [],
        usage: {},
        costUsd: 0,
        image: { dataUrl: "data:image/jpeg;base64,AAAA", mimeType: "image/jpeg" },
      },
    });
    const assistant = next.messages.find((m) => m.kind === "assistant");
    expect(assistant?.kind).toBe("assistant");
    if (assistant?.kind !== "assistant") return;
    expect(assistant.segments.at(-1)).toMatchObject({
      kind: "image",
      dataUrl: "data:image/jpeg;base64,AAAA",
      mimeType: "image/jpeg",
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

  it("replaces streamed degeneration with the authoritative trimmed final", () => {
    let state = reduce(initialState(), { t: "incoming", event: turnStarted });
    state = reduce(state, {
      t: "incoming",
      event: {
        type: "model.delta",
        id: 2,
        ts: "2026-05-27T00:00:00.000Z",
        turn: 1,
        channel: "content",
        text: "Safe prefix wrightwrightwright",
      },
    });
    const next = reduce(state, {
      t: "incoming",
      event: {
        type: "model.final",
        id: 3,
        ts: "2026-05-27T00:00:00.000Z",
        turn: 1,
        content: "Safe prefix ",
        reasoningContent: "Checked files.",
        replaceStreamedOutput: true,
        toolCalls: [],
        usage: {},
        costUsd: 0,
      },
    });
    const assistant = next.messages.find((m) => m.kind === "assistant");
    if (assistant?.kind !== "assistant") throw new Error("no assistant message");
    expect(assistant.pending).toBe(false);
    expect(assistant.segments).toEqual([
      { kind: "reasoning", text: "Checked files." },
      { kind: "text", text: "Safe prefix " },
    ]);
  });

  it("attaches degeneration warnings as a warning card segment on the active assistant message", () => {
    let state = reduce(initialState(), { t: "incoming", event: turnStarted });
    state = reduce(state, {
      t: "incoming",
      event: {
        type: "model.final",
        id: 2,
        ts: "2026-05-27T00:00:00.000Z",
        turn: 1,
        content: "Useful text before loop.",
        toolCalls: [],
        usage: {},
        costUsd: 0,
      },
    });
    const next = reduce(state, {
      t: "incoming",
      event: {
        type: "warning",
        id: 3,
        ts: "2026-05-27T00:00:00.000Z",
        turn: 1,
        text: "Stopped a degenerating model stream after detecting 1024 repeated characters (period 6) in content output.",
        severity: "high",
      },
    });
    const assistant = next.messages.find((m) => m.kind === "assistant");
    if (assistant?.kind !== "assistant") throw new Error("no assistant message");
    expect(assistant.segments).toEqual([
      { kind: "text", text: "Useful text before loop." },
      {
        kind: "warning",
        id: "w-3",
        text: "Stopped a degenerating model stream after detecting 1024 repeated characters (period 6) in content output.",
        severity: "high",
      },
    ]);
  });

  it("anchors a late warning to its assistant turn instead of the latest assistant", () => {
    const base = initialState();
    const state = {
      ...base,
      messages: [
        { kind: "user" as const, text: "first", clientId: "c-1", turn: 1 },
        {
          kind: "assistant" as const,
          turn: 1,
          segments: [{ kind: "text" as const, text: "first answer" }],
          pending: false,
        },
        { kind: "user" as const, text: "second", clientId: "c-2", turn: 2 },
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
        type: "warning",
        id: 4,
        ts: "2026-05-27T00:00:00.000Z",
        turn: 1,
        text: "Late warning from turn one",
        severity: "high",
      },
    });
    const assistants = next.messages.filter((m) => m.kind === "assistant");

    expect(assistants[0]?.segments.at(-1)).toMatchObject({
      kind: "warning",
      id: "w-4",
      text: "Late warning from turn one",
    });
    expect(assistants[1]?.segments).toEqual([{ kind: "text", text: "second answer" }]);
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
    expect(next.messages.at(-1)).toMatchObject({ kind: "notice", severity: "error" });
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
        quickSendId: "proceed",
        quickSends: [],
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
        quickSendId: "proceed",
        quickSends: [],
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
        quickSendId: "proceed",
        quickSends: [],
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

  it("falls back to running subagent candidate when parentCallId does not match segment callId", () => {
    const base = {
      ...initialState(),
      messages: [
        {
          kind: "assistant" as const,
          turn: 5,
          pending: true,
          segments: [
            {
              kind: "tool" as const,
              callId: "tc-1",
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
    const event = {
      type: "subagent.progress" as const,
      id: 1,
      ts: "2026-06-01T00:00:00.000Z",
      turn: 5,
      runId: "run-mismatched",
      parentCallId: "loop-internal-call-id",
      action: "start" as const,
      task: "investigate quick send",
    };

    const next = send(base, event);
    const assistant = next.messages[0];
    if (assistant?.kind !== "assistant") throw new Error("expected assistant");
    expect(assistant.segments[0]).toMatchObject({
      callId: "tc-1",
      subagentRuns: [{ runId: "run-mismatched", task: "investigate quick send" }],
    });
  });

  it("accumulates thinking and process rows into recentRows on subagent.progress", () => {
    const base = {
      ...initialState(),
      messages: [
        {
          kind: "assistant" as const,
          turn: 3,
          pending: true,
          segments: [
            {
              kind: "tool" as const,
              callId: "parent-sub",
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
      turn: 3,
      runId: "run-act",
      parentCallId: "parent-sub",
      task: "explore codebase",
    };

    let state = send(base, { ...common, id: 1, action: "start" });
    state = send(state, {
      ...common,
      id: 2,
      action: "stream",
      thought: "Analyzing the architecture...",
    });
    state = send(state, {
      ...common,
      id: 3,
      action: "tool-start",
      toolName: "read_file",
      toolArgs: "src/index.ts",
    });

    const assistant = state.messages[0];
    if (assistant?.kind !== "assistant") throw new Error("expected assistant");
    const run = (assistant.segments[0] as { subagentRuns?: Array<{ recentRows?: unknown[] }> })
      ?.subagentRuns?.[0];

    expect(run?.recentRows).toHaveLength(3);
    expect(run?.recentRows?.[0]).toMatchObject({
      kind: "process",
      text: "Starting subagent...",
      status: "running",
    });
    expect(run?.recentRows?.[1]).toMatchObject({
      kind: "thinking",
      text: "Analyzing the architecture...",
    });
    expect(run?.recentRows?.[2]).toMatchObject({
      kind: "process",
      text: "↳ read_file src/index.ts",
      status: "running",
    });
  });

  it("keeps the latest three streamed lines as live activity rows", () => {
    const base = {
      ...initialState(),
      messages: [
        {
          kind: "assistant" as const,
          turn: 4,
          pending: true,
          segments: [
            {
              kind: "tool" as const,
              callId: "parent-live",
              name: "research",
              args: "{}",
              startedAt: 1,
            },
          ],
        },
      ],
    };
    const common = {
      type: "subagent.progress" as const,
      ts: "2026-06-01T00:00:00.000Z",
      turn: 4,
      runId: "run-live",
      parentCallId: "parent-live",
      task: "research docs",
      skillName: "research",
    };

    let state = reduce(base, { t: "incoming", event: { ...common, id: 1, action: "start" } });
    state = reduce(state, {
      t: "incoming",
      event: {
        ...common,
        id: 2,
        action: "stream",
        reasoningChars: 30,
        thought: "First line\nSecond line\nThird line\nFourth line",
      },
    });
    state = reduce(state, {
      t: "incoming",
      event: {
        ...common,
        id: 3,
        action: "stream",
        reasoningChars: 40,
        thought: "Second line\nThird line\nFourth line updated",
      },
    });

    const assistant = state.messages[0];
    if (assistant?.kind !== "assistant") throw new Error("expected assistant");
    const run = (
      assistant.segments[0] as {
        subagentRuns?: Array<{ recentRows?: Array<{ kind: string; text: string }> }>;
      }
    ).subagentRuns?.[0];

    expect(run?.recentRows?.slice(-3)).toEqual([
      expect.objectContaining({ kind: "thinking", text: "Second line" }),
      expect.objectContaining({ kind: "thinking", text: "Third line" }),
      expect.objectContaining({ kind: "thinking", text: "Fourth line updated" }),
    ]);
  });
});

describe("Desktop App reducer — tool.output live shell output", () => {
  function stateWithShellCall(turn = 1, callId = "tc-1") {
    return {
      ...initialState(),
      messages: [
        {
          kind: "assistant" as const,
          turn,
          pending: true,
          segments: [
            {
              kind: "tool" as const,
              callId,
              name: "run_command",
              args: JSON.stringify({ command: "npm test" }),
              startedAt: 1,
            },
          ],
        },
      ],
    };
  }

  function outputEvent(
    text: string,
    overrides: Partial<import("./protocol").ToolOutputEvent> = {},
  ) {
    return {
      type: "tool.output" as const,
      id: 1,
      ts: "2026-06-01T00:00:00.000Z",
      turn: 1,
      callId: "tc-1",
      name: "run_command",
      text,
      ...overrides,
    };
  }

  it("accumulates streamed output onto the matching running shell segment", () => {
    const afterFirst = reduce(stateWithShellCall(), {
      t: "incoming",
      event: outputEvent("pass 1\n"),
    });
    const assistant = afterFirst.messages[0];
    if (assistant?.kind !== "assistant") throw new Error("expected assistant");
    expect(assistant.segments[0]).toMatchObject({ liveOutput: "pass 1\n" });

    const afterSecond = reduce(afterFirst, {
      t: "incoming",
      event: outputEvent("pass 2\n", { id: 2 }),
    });
    const settled = afterSecond.messages[0];
    if (settled?.kind !== "assistant") throw new Error("expected assistant");
    expect(settled.segments[0]).toMatchObject({ liveOutput: "pass 1\npass 2\n" });
  });

  it("ignores output that arrives after the tool result settled the segment", () => {
    const state = stateWithShellCall();
    const withResult = reduce(state, {
      t: "incoming",
      event: {
        type: "tool.result",
        id: 5,
        ts: "2026-06-01T00:00:00.000Z",
        turn: 1,
        callId: "tc-1",
        ok: true,
        output: "pass 1\npass 2\n",
      },
    });
    const afterLate = reduce(withResult, {
      t: "incoming",
      event: outputEvent("stray\n", { id: 6 }),
    });
    const assistant = afterLate.messages[0];
    if (assistant?.kind !== "assistant") throw new Error("expected assistant");
    const seg = assistant.segments[0];
    if (!seg || seg.kind !== "tool") throw new Error("expected tool segment");
    expect(seg.result).toBe("pass 1\npass 2\n");
    expect(seg.liveOutput).toBeUndefined();
  });

  it("does not attach output to segments on other turns or call ids", () => {
    const state = {
      ...stateWithShellCall(2, "tc-9"),
      messages: [
        ...stateWithShellCall(1, "tc-1").messages,
        ...stateWithShellCall(2, "tc-9").messages,
      ],
    };
    const next = reduce(state, {
      t: "incoming",
      event: outputEvent("mine\n", { turn: 1, callId: "tc-1" }),
    });
    const first = next.messages[0];
    const second = next.messages[1];
    if (first?.kind !== "assistant" || second?.kind !== "assistant") {
      throw new Error("expected assistant");
    }
    expect(first.segments[0]).toMatchObject({ liveOutput: "mine\n" });
    const other = second.segments[0];
    if (!other || other.kind !== "tool") throw new Error("expected tool segment");
    expect(other.liveOutput).toBeUndefined();
  });
});

describe("Desktop App reducer — plan timeline anchor", () => {
  it("selects the active plan only for its original submit_plan message", () => {
    const plan = {
      plan: "Implement the timeline",
      steps: [],
      completedStepIds: [],
      stepResults: {},
      callId: "plan-call-42",
    };
    const before = {
      kind: "assistant" as const,
      turn: 1,
      pending: false,
      segments: [{ kind: "text" as const, text: "before" }],
    };
    const anchored = {
      kind: "assistant" as const,
      turn: 2,
      pending: false,
      segments: [
        {
          kind: "tool" as const,
          callId: "plan-call-42",
          name: "submit_plan",
          args: "{}",
          startedAt: 1,
        },
      ],
    };
    const after = {
      kind: "assistant" as const,
      turn: 3,
      pending: false,
      segments: [{ kind: "text" as const, text: "after" }],
    };

    expect(activePlanForMessage(before, plan)).toBeUndefined();
    expect(activePlanForMessage(anchored, plan)).toBe(plan);
    expect(activePlanForMessage(after, plan)).toBeUndefined();
  });

  it("preserves the submit_plan call id when an approved plan becomes active", () => {
    let state = reduce(initialState(), {
      t: "incoming",
      event: {
        type: "$plan_required",
        id: 7,
        plan: "Implement the timeline",
        summary: "Chronological plan",
        callId: "plan-call-42",
        steps: [
          {
            id: "step-1",
            title: "Anchor the card",
            action: "Render it at the submit_plan segment.",
          },
        ],
      },
    });

    state = reduce(state, {
      t: "resolve_plan",
      id: 7,
      verdict: { type: "approve" },
    });

    expect(state.activePlan).toMatchObject({
      callId: "plan-call-42",
      plan: "Implement the timeline",
      completedStepIds: [],
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
