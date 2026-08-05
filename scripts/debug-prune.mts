import { DeepSeekClient } from "../src/client.js";
import { CacheFirstLoop } from "../src/loop.js";
import { ImmutablePrefix } from "../src/memory/runtime.js";
import { countTokensBounded } from "../src/tokenizer.js";

process.env.PRUNE_DEBUG = "1";

function okJsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function seedTurns(loop: CacheFirstLoop, n: number): void {
  for (let i = 0; i < n; i++) {
    loop.log.append({ role: "user", content: `question ${i}: ${"context padding for prune step regression ".repeat(8)}` });
    loop.log.append({ role: "assistant", content: `answer ${i}: ${"more context padding for prune step regression ".repeat(8)}` });
  }
}

let capturedBody: { messages: unknown[] } | null = null;
const client = new DeepSeekClient({
  apiKey: "sk-test",
  fetch: (async (_url: unknown, init: { body?: string } | undefined) => {
    capturedBody = JSON.parse(init?.body ?? "{}") as { messages: unknown[] };
    return okJsonResponse({ choices: [{ message: { content: "SUMMARY" } }] });
  }) as typeof fetch,
});
const loop = new CacheFirstLoop({ client, prefix: new ImmutablePrefix({ system: "s" }), stream: false });
seedTurns(loop, 6);
loop.log.append({ role: "user", content: "read src/dead.ts" });
loop.log.append({
  role: "assistant",
  content: "",
  tool_calls: [{ id: "call-dead", type: "function", function: { name: "read_file", arguments: JSON.stringify({ path: "src/dead.ts" }) } }],
});
loop.log.append({ role: "tool", tool_call_id: "call-dead", name: "read_file", content: "DEAD BODY ".repeat(40) });
loop.log.append({ role: "user", content: "read src/live.ts" });
loop.log.append({
  role: "assistant",
  content: "",
  tool_calls: [{ id: "call-live", type: "function", function: { name: "read_file", arguments: JSON.stringify({ path: "src/live.ts" }) } }],
});
loop.log.append({ role: "tool", tool_call_id: "call-live", name: "read_file", content: "LIVE BODY ".repeat(10) });
loop.log.append({
  role: "assistant",
  content: "",
  tool_calls: [{ id: "call-edit", type: "function", function: { name: "edit_file", arguments: JSON.stringify({ path: "src/live.ts", search: "old", replace: "new" }) } }],
});
loop.log.append({ role: "tool", tool_call_id: "call-edit", name: "edit_file", content: "edit blocks: 1/1 applied" });

const all = loop.log.entries;
console.log("total messages:", all.length);
console.log("index of call-live msg:", all.findIndex((m) => Array.isArray(m.tool_calls) && m.tool_calls.some((c) => c.id === "call-live")));
console.log("index of toolL:", all.findIndex((m) => m.tool_call_id === "call-live"));
console.log("last user idx:", all.map((m, i) => (m.role === "user" ? i : -1)).filter((i) => i >= 0).at(-1));
console.log("tail tokens from end:", [
  all.at(-1), all.at(-2), all.at(-3), all.at(-4), all.at(-5), all.at(-6), all.at(-7), all.at(-8),
].map((m) => countTokensBounded(typeof m?.content === "string" ? m.content : "")).join(", "));

const result = await loop.compactHistory({ keepRecentTokens: 120 });
console.log("folded:", result.folded, "prunedFiles:", result.prunedFiles, "prunedTokens:", result.prunedTokens);
console.log("committed count:", loop.log.entries.length);
console.log("committed call-live:", loop.log.entries.find((m) => m.tool_call_id === "call-live")?.content?.slice(0, 40));
console.log("request has call-live:", capturedBody?.messages.some((m) => (m as { tool_call_id?: string }).tool_call_id === "call-live"));
console.log("request has call-dead stub:", capturedBody?.messages.some((m) => String((m as { content?: unknown }).content).includes("pruned")));
console.log("committed first content:", loop.log.entries[0]?.content?.slice(0, 30));
