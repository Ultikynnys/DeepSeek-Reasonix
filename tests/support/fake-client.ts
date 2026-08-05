/** Shared fake DeepSeek HTTP harness for loop / context-manager / subagent tests. */

import { vi } from "vitest";
import { DeepSeekClient } from "../../src/client.js";
import type { ChatMessage, ToolSpec } from "../../src/types.js";

export interface FakeResponseShape {
  content?: string;
  reasoning_content?: string;
  tool_calls?: Array<{
    id: string;
    type?: "function";
    function: { name: string; arguments: string };
  }>;
  usage?: Record<string, number>;
}

/** Deep-captured copy of one request body, for tests that assert on what the client sent. */
export interface CapturedRequest {
  model: string;
  messages: ChatMessage[];
  tools: ToolSpec[] | undefined;
  thinking: string | undefined;
  reasoning_effort: string | undefined;
  extra_body: Record<string, unknown> | undefined;
  body: Record<string, unknown>;
}

export interface MakeFakeClientOptions {
  /** Include `_echo_messages` (the request messages) in JSON responses. Default true. */
  echoMessages?: boolean;
  /** Called with each captured request body, in order. */
  capture?: (req: CapturedRequest) => void;
}

export interface MakeFakeClientResult {
  client: DeepSeekClient;
  /** The underlying vi.fn — assert call counts / payloads. */
  fetchMock: ReturnType<typeof vi.fn>;
  /** Every request body seen, in order. */
  captured: CapturedRequest[];
}

const DEFAULT_USAGE = {
  prompt_tokens: 100,
  completion_tokens: 20,
  total_tokens: 120,
  prompt_cache_hit_tokens: 0,
  prompt_cache_miss_tokens: 100,
};

/** Canned-response DeepSeekClient — responses round-robin (last repeats); requests with `stream: true` get SSE frames. */
export function makeFakeClient(
  responses: FakeResponseShape[],
  opts: MakeFakeClientOptions = {},
): MakeFakeClientResult {
  const captured: CapturedRequest[] = [];
  let i = 0;
  const fetchMock = vi.fn(async (_url: unknown, init: { body?: string } | undefined) => {
    const body = init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    const messages = (body.messages ?? []) as ChatMessage[];
    const extra = body.extra_body as { thinking?: { type?: string } } | undefined;
    const req: CapturedRequest = {
      model: (body.model as string | undefined) ?? "",
      messages,
      tools: body.tools as ToolSpec[] | undefined,
      thinking: extra?.thinking?.type,
      reasoning_effort: body.reasoning_effort as string | undefined,
      extra_body: body.extra_body as Record<string, unknown> | undefined,
      body,
    };
    captured.push(req);
    opts.capture?.(req);
    const resp = responses[i++] ?? responses[responses.length - 1]!;
    const usage = resp.usage ?? DEFAULT_USAGE;
    if (body.stream === true) {
      const finish = resp.tool_calls ? "tool_calls" : "stop";
      const delta: Record<string, unknown> = {};
      if (resp.content) delta.content = resp.content;
      if (resp.reasoning_content) delta.reasoning_content = resp.reasoning_content;
      if (resp.tool_calls) delta.tool_calls = resp.tool_calls;
      const frames = [
        `data: ${JSON.stringify({ choices: [{ index: 0, delta }] })}\n\n`,
        `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: finish }], usage })}\n\n`,
        "data: [DONE]\n\n",
      ];
      return new Response(new TextEncoder().encode(frames.join("")), {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    }
    const payload: Record<string, unknown> = {};
    if (opts.echoMessages !== false) payload._echo_messages = messages;
    payload.choices = [
      {
        index: 0,
        message: {
          role: "assistant",
          content: resp.content ?? "",
          reasoning_content: resp.reasoning_content ?? null,
          tool_calls: resp.tool_calls ?? undefined,
        },
        finish_reason: resp.tool_calls ? "tool_calls" : "stop",
      },
    ];
    payload.usage = usage;
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });
  return {
    client: new DeepSeekClient({
      apiKey: "sk-test",
      fetch: fetchMock as unknown as typeof fetch,
    }),
    fetchMock,
    captured,
  };
}

/** Fetch that hangs until the caller's AbortSignal fires — for abort/race tests. */
export function neverResolvingFetch(): typeof fetch {
  return vi.fn((_url: unknown, init: { signal?: AbortSignal } | undefined) => {
    const signal = init?.signal;
    return new Promise<Response>((_resolve, reject) => {
      if (signal?.aborted) {
        reject(new Error("aborted"));
        return;
      }
      signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    });
  }) as unknown as typeof fetch;
}

/** 200 JSON response helper shared by fold tests. */
export function jsonOkResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
