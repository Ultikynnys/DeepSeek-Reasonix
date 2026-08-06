/** Pure projection reducers over the Event log — deterministic, no I/O, no mutation. */

import type { ChatMessage } from "../types.js";
import { EventType } from "./events.js";
import type {
  BudgetView,
  CapabilityView,
  ConversationView,
  Event,
  PlanStepView,
  PlanView,
  ProjectionSet,
  Reducer,
  SessionMetaView,
  StatusView,
  WorkspaceView,
} from "./events.js";

export function emptyConversation(): ConversationView {
  return { messages: [], pendingToolCalls: [] };
}

export function emptyBudget(capUsd: number | null = null): BudgetView {
  return {
    spentUsd: 0,
    capUsd,
    promptTokens: 0,
    completionTokens: 0,
    cacheHitTokens: 0,
    cacheMissTokens: 0,
    warned: false,
    blocked: false,
  };
}

export function emptyPlan(): PlanView {
  return { steps: [], body: null, submittedTurn: null };
}

export function emptyWorkspace(): WorkspaceView {
  return { filesTouched: new Map(), lastCheckpointId: null };
}

export function emptyCapabilities(): CapabilityView {
  return { tools: [] };
}

export function emptyStatus(): StatusView {
  return { current: null };
}

export function emptySessionMeta(): SessionMetaView {
  return {
    name: null,
    openedAt: null,
    resumedFromTurn: null,
    currentTurn: 0,
    lastError: null,
  };
}

export function emptyProjections(capUsd: number | null = null): ProjectionSet {
  return {
    conversation: emptyConversation(),
    budget: emptyBudget(capUsd),
    plan: emptyPlan(),
    workspace: emptyWorkspace(),
    capabilities: emptyCapabilities(),
    status: emptyStatus(),
    session: emptySessionMeta(),
  };
}

export const conversation: Reducer<ConversationView> = (v, ev) => {
  switch (ev.type) {
    case EventType.userMessage: {
      const msg: ChatMessage = { role: "user", content: ev.text };
      return { ...v, messages: [...v.messages, msg] };
    }
    case EventType.modelFinal: {
      const msg: ChatMessage = { role: "assistant", content: ev.content };
      if (ev.toolCalls.length > 0) msg.tool_calls = [...ev.toolCalls];
      if (ev.reasoningContent !== undefined) msg.reasoning_content = ev.reasoningContent;
      return { ...v, messages: [...v.messages, msg] };
    }
    case EventType.toolIntent:
      return {
        ...v,
        pendingToolCalls: [...v.pendingToolCalls, { callId: ev.callId, name: ev.name }],
      };
    case EventType.toolResult: {
      const msg: ChatMessage = { role: "tool", content: ev.output, tool_call_id: ev.callId };
      return {
        messages: [...v.messages, msg],
        pendingToolCalls: v.pendingToolCalls.filter((c) => c.callId !== ev.callId),
      };
    }
    case EventType.toolDenied: {
      const msg: ChatMessage = {
        role: "tool",
        content: `denied: ${ev.reason}`,
        tool_call_id: ev.callId,
      };
      return {
        messages: [...v.messages, msg],
        pendingToolCalls: v.pendingToolCalls.filter((c) => c.callId !== ev.callId),
      };
    }
    case EventType.sessionCompacted:
    case EventType.sessionRetracted:
      return { messages: [...ev.replacementMessages], pendingToolCalls: [] };
    default:
      return v;
  }
};

export const budget: Reducer<BudgetView> = (v, ev) => {
  switch (ev.type) {
    case EventType.modelFinal: {
      const u = ev.usage;
      return {
        ...v,
        spentUsd: v.spentUsd + ev.costUsd,
        promptTokens: v.promptTokens + (u.prompt_tokens ?? 0),
        completionTokens: v.completionTokens + (u.completion_tokens ?? 0),
        cacheHitTokens: v.cacheHitTokens + (u.prompt_cache_hit_tokens ?? 0),
        cacheMissTokens: v.cacheMissTokens + (u.prompt_cache_miss_tokens ?? 0),
      };
    }
    case EventType.policyBudgetWarning:
      return { ...v, warned: true };
    case EventType.policyBudgetBlocked:
      return { ...v, blocked: true };
    default:
      return v;
  }
};

export const plan: Reducer<PlanView> = (v, ev) => {
  switch (ev.type) {
    case EventType.planSubmitted: {
      const steps: PlanStepView[] = ev.steps.map((s) => ({
        id: s.id,
        title: s.title,
        action: s.action,
        risk: s.risk,
        completed: false,
      }));
      return { steps, body: ev.body, submittedTurn: ev.turn };
    }
    case EventType.planStepCompleted: {
      if (!v.steps.some((s) => s.id === ev.stepId)) return v;
      return {
        ...v,
        steps: v.steps.map((s) =>
          s.id === ev.stepId ? { ...s, completed: true, notes: ev.notes } : s,
        ),
      };
    }
    default:
      return v;
  }
};

export const workspace: Reducer<WorkspaceView> = (v, ev) => {
  switch (ev.type) {
    case EventType.effectFileTouched: {
      const next = new Map(v.filesTouched);
      next.set(ev.path, ev.mode);
      return { ...v, filesTouched: next };
    }
    case EventType.checkpointCreated:
      return { ...v, lastCheckpointId: ev.checkpointId };
    default:
      return v;
  }
};

export const capabilities: Reducer<CapabilityView> = (v, ev) => {
  switch (ev.type) {
    case EventType.capabilityRegistered: {
      const filtered = v.tools.filter((t) => t.name !== ev.name);
      return { tools: [...filtered, { name: ev.name, permission: ev.permission }] };
    }
    case EventType.capabilityRemoved:
      return { tools: v.tools.filter((t) => t.name !== ev.name) };
    default:
      return v;
  }
};

const STATUS_CLEARING: ReadonlySet<Event["type"]> = new Set([
  EventType.modelDelta,
  EventType.modelFinal,
  EventType.toolDispatched,
  EventType.toolResult,
  EventType.toolDenied,
  EventType.error,
]);

export const status: Reducer<StatusView> = (v, ev) => {
  if (ev.type === EventType.status) return { current: ev.text };
  if (STATUS_CLEARING.has(ev.type) && v.current !== null) return { current: null };
  return v;
};

export const sessionMeta: Reducer<SessionMetaView> = (v, ev) => {
  let next = v;
  if (ev.turn > next.currentTurn) next = { ...next, currentTurn: ev.turn };
  switch (ev.type) {
    case EventType.sessionOpened:
      return {
        ...next,
        name: ev.name,
        openedAt: ev.ts,
        resumedFromTurn: ev.resumedFromTurn,
      };
    case EventType.error:
      return { ...next, lastError: ev.message };
    default:
      return next;
  }
};

export function apply(state: ProjectionSet, ev: Event): ProjectionSet {
  return {
    conversation: conversation(state.conversation, ev),
    budget: budget(state.budget, ev),
    plan: plan(state.plan, ev),
    workspace: workspace(state.workspace, ev),
    capabilities: capabilities(state.capabilities, ev),
    status: status(state.status, ev),
    session: sessionMeta(state.session, ev),
  };
}

export function replay(events: Iterable<Event>, capUsd: number | null = null): ProjectionSet {
  let s = emptyProjections(capUsd);
  for (const ev of events) s = apply(s, ev);
  return s;
}
