import { countTokensBounded } from "./tokenizer.js";
import type { ChatMessage, ToolCall } from "./types.js";

/** Compaction step 2: drop `read_file` contents that nothing references anymore.
 *
 *  Long sessions accumulate full file bodies in the log (each read result can
 *  be tens of KiB). By the time a fold runs, most of them were read once and
 *  never referenced again — yet the fold ships the ENTIRE head to the
 *  summarizer and the surviving tail keeps the dead bytes until the next
 *  fold. This pass stubs those results so the summarizer request and the
 *  post-fold context stop carrying the cache.
 *
 *  A read is "unused" iff ALL of:
 *   1. its content is longer than the stub (stubbing actually saves tokens),
 *   2. no LATER tool call in the log references the same path (any path-bearing
 *      tool — read/edit/write/search/list/symbol), and
 *   3. it is not part of the active exchange (message index at or after the
 *      last user message). Without this guard the post-response fold would
 *      stub the very tool results protectActiveExchange exists to preserve.
 *
 *  Pure: returns a new message array, never mutates the input. Message count
 *  is preserved (only content is replaced), so fold boundary math and the
 *  merge-at-commit slice stay valid. tool_call pairing is untouched.
 */

export interface FilePruneResult {
  messages: ChatMessage[];
  /** Unique paths whose read results were stubbed. */
  prunedFiles: string[];
  /** Token savings from stubbing (sum of content tokens − stub tokens). */
  tokensSaved: number;
}

/** Replaces a pruned read result's content. Kept exported so tests can pin the format. */
export function pruneStubFor(path: string): string {
  return `[file pruned: ${path} — contents removed by compaction (unreferenced since read); call read_file to reload]`;
}

interface CallRecord {
  /** Message index of the assistant message carrying the call. */
  msgIdx: number;
  id: string;
  name: string;
  path: string;
  /** Paths this call references — recorded for the "referenced later" scan. */
  refs: string[];
}

export function pruneUnusedFileReads(messages: readonly ChatMessage[]): FilePruneResult {
  const out = messages.slice();
  const prunedFiles: string[] = [];
  let tokensSaved = 0;
  if (messages.length === 0) return { messages: out, prunedFiles, tokensSaved };

  // Index of the most recent user message — reads after it belong to the
  // turn that's still producing output and must survive (the model hasn't
  // had a chance to reference them yet).
  let lastUserIdx = -1;
  for (let i = 0; i < messages.length; i++) {
    if (messages[i]!.role === "user") lastUserIdx = i;
  }

  const calls: CallRecord[] = [];
  const refsByIndex: Array<readonly string[]> = new Array(messages.length);
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]!;
    if (msg.role !== "assistant" || !Array.isArray(msg.tool_calls)) continue;
    const refs: string[] = [];
    for (const call of msg.tool_calls) {
      const callRefs = pathsFromCallArgs(call);
      refs.push(...callRefs);
      const id = call.id ?? "";
      const name = call.function?.name ?? "";
      if (name === "read_file" && id.length > 0) {
        const path = callRefs[0];
        if (path) {
          calls.push({ msgIdx: i, id, name, path, refs: callRefs });
        }
      }
    }
    if (refs.length > 0) refsByIndex[i] = refs;
  }

  // tool_call_id → result message index (first match; a call has one result).
  const resultIdxByCallId = new Map<string, number>();
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]!;
    if (msg.role !== "tool" || typeof msg.tool_call_id !== "string") continue;
    if (!resultIdxByCallId.has(msg.tool_call_id)) resultIdxByCallId.set(msg.tool_call_id, i);
  }

  // For each path, the LAST message index that references it. A read at
  // message i is referenced later iff lastRefIdx(path) > i (same-message
  // sibling refs are handled separately below).
  const lastRefIdx = new Map<string, number>();
  for (let i = 0; i < messages.length; i++) {
    const refs = refsByIndex[i];
    if (!refs) continue;
    for (const p of refs) lastRefIdx.set(p, i);
  }

  // Per (message, path) reference counts from ALL calls — lets a candidate
  // read tell its own reference apart from a sibling call's (e.g. parallel
  // read + edit of the same path in one assistant message).
  const refCountByMsgPath = new Map<string, number>();
  for (let i = 0; i < messages.length; i++) {
    const refs = refsByIndex[i];
    if (!refs) continue;
    for (const p of refs) {
      const key = `${i}\u0000${p}`;
      refCountByMsgPath.set(key, (refCountByMsgPath.get(key) ?? 0) + 1);
    }
  }

  for (const call of calls) {
    // Active-exchange guard: the current turn's reads must survive the fold.
    if (call.msgIdx > lastUserIdx) continue;
    const resultIdx = resultIdxByCallId.get(call.id);
    if (resultIdx === undefined) continue;
    const result = out[resultIdx];
    if (!result || result.role !== "tool") continue;
    const content = typeof result.content === "string" ? result.content : "";
    const stub = pruneStubFor(call.path);
    // Only stub when it actually saves tokens — error strings and tiny
    // results are cheaper left verbatim.
    if (content.length <= stub.length) continue;
    // Referenced later anywhere in the log → the content is still load-bearing.
    const lastIdx = lastRefIdx.get(call.path) ?? -1;
    let referencedLater = lastIdx > call.msgIdx;
    if (!referencedLater && lastIdx === call.msgIdx) {
      // The last reference sits in the SAME assistant message: a sibling call
      // (parallel read/edit of the same path) counts, the read's own call
      // does not.
      referencedLater = (refCountByMsgPath.get(`${call.msgIdx}\u0000${call.path}`) ?? 0) > 1;
    }
    if (referencedLater) continue;

    const beforeTokens = countTokensBounded(content);
    const afterTokens = countTokensBounded(stub);
    out[resultIdx] = { ...result, content: stub };
    prunedFiles.push(call.path);
    tokensSaved += Math.max(0, beforeTokens - afterTokens);
  }

  return {
    messages: out,
    prunedFiles: [...new Set(prunedFiles)],
    tokensSaved,
  };
}

/** Extract path references from a tool call's JSON args: `path` and `edits[].path`. */
function pathsFromCallArgs(call: ToolCall): string[] {
  const raw = call.function?.arguments;
  if (typeof raw !== "string" || raw.length === 0) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return [];
  const out: string[] = [];
  const args = parsed as Record<string, unknown>;
  if (typeof args.path === "string" && args.path.length > 0) out.push(args.path);
  if (Array.isArray(args.edits)) {
    for (const edit of args.edits) {
      if (!edit || typeof edit !== "object") continue;
      const p = (edit as Record<string, unknown>).path;
      if (typeof p === "string" && p.length > 0) out.push(p);
    }
  }
  return out;
}
