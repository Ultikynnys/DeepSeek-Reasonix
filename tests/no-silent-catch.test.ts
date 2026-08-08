// No silent catch blocks — a catch whose body is empty (or comment-only)
// swallows the failure. That is the exact class of bug that made compaction
// die without any visible error. Every catch in the durability-critical +
// user-facing surfaces below must surface its failure: a stderr write, an
// error return, an emitted event, or a rethrow.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, test } from "vitest";

const TARGET_DIRS = ["src/core", "src/memory", "src/adapters", "src/cli/commands"];
const TARGET_FILES = ["src/context-manager.ts", "src/loop.ts"];

function collect(): string[] {
  const out: string[] = [];
  for (const rel of TARGET_DIRS) {
    const root = join(process.cwd(), rel);
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (p.endsWith(".ts") && !p.endsWith(".d.ts")) out.push(p);
      }
    };
    walk(root);
  }
  for (const rel of TARGET_FILES) out.push(join(process.cwd(), rel));
  return out;
}

function stripComments(s: string): string {
  return s
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((l) => l.replace(/\/\/.*$/, ""))
    .join("\n");
}

/** Catch blocks whose body is empty or comment-only after stripping. */
function silentCatches(src: string): Array<{ line: number }> {
  const out: Array<{ line: number }> = [];
  const lines = src.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = line.match(/\bcatch\s*(?:\([^)]*\))?\s*\{/);
    if (!m) continue;
    const before = line.slice(0, m.index);
    if (before.includes("//") || /["'`]/.test(before)) continue;
    const bodyStart = line.lastIndexOf("{");
    let body = line.slice(bodyStart + 1);
    const closeSame = body.indexOf("}");
    if (closeSame !== -1) {
      body = body.slice(0, closeSame);
    } else {
      let j = i + 1;
      while (j < lines.length) {
        const seg = lines[j];
        const close = seg.indexOf("}");
        if (close !== -1) {
          body += seg.slice(0, close);
          break;
        }
        body += `${seg}\n`;
        j++;
      }
    }
    if (stripComments(body).trim() === "") out.push({ line: i + 1 });
  }
  return out;
}

describe("no silent catch blocks", () => {
  test("swallow-only catches are banned in core durability + CLI surfaces", () => {
    const offenders: string[] = [];
    for (const p of collect()) {
      const src = readFileSync(p, "utf8");
      for (const c of silentCatches(src)) {
        offenders.push(`${relative(process.cwd(), p)}:${c.line} — empty/comment-only catch body`);
      }
    }
    expect(
      offenders,
      "Swallow-only catches hide failures. Make them loud: stderr write, error return, or emitted event.",
    ).toEqual([]);
  });
});
