/** SEARCH must match byte-for-byte; empty SEARCH = create new file. No fuzzy match — silent wrong edit beats a missing one. */

import {
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  writeSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { looksLikeAbsoluteSystemPath, pathIsUnder } from "@reasonix/core-utils/path-utils";
import { atomicReplaceFileSync } from "../core/atomic-write.js";
import { decodeFileBuffer, encodeFile } from "./file-encoding.js";

export interface EditBlock {
  /** Path as written by the model — relative to rootDir, or absolute. */
  path: string;
  /** Literal text to match in the target file. Empty → create new file. */
  search: string;
  /** Replacement text to write in place of `search`. */
  replace: string;
  /** Char offset in the source message where this block started. */
  offset: number;
}

export type ApplyStatus =
  /** Edit landed on disk. */
  | "applied"
  /** New file created (SEARCH was empty and file didn't exist). */
  | "created"
  /** File exists but SEARCH block wasn't found in its content. */
  | "not-found"
  /** File doesn't exist and SEARCH was non-empty (can't create without content). */
  | "file-missing"
  /** Path escapes rootDir — refused on safety grounds. */
  | "path-escape"
  /** fs write / read threw. */
  | "error";

export interface ApplyResult {
  path: string;
  status: ApplyStatus;
  /** Extra detail (e.g. error message) for logs. */
  message?: string;
}

// `^` + `m` keeps a JS string containing `<<<<<<< SEARCH` from matching as a real block.
// `\n?` makes empty SEARCH/REPLACE bodies legal (new-file / future delete sentinels).
const BLOCK_RE = /^(\S[^\n]*)\n<{7} SEARCH\n([\s\S]*?)\n?={7}\n([\s\S]*?)\n?>{7} REPLACE/gm;

export function parseEditBlocks(text: string): EditBlock[] {
  const out: EditBlock[] = [];
  BLOCK_RE.lastIndex = 0;
  let m: RegExpExecArray | null = BLOCK_RE.exec(text);
  while (m !== null) {
    out.push({
      path: m[1]!.trim(),
      search: m[2]!,
      replace: m[3]!,
      offset: m.index,
    });
    m = BLOCK_RE.exec(text);
  }
  return out;
}

function resolveEditPath(rootDir: string, rawPath: string): string {
  const absRoot = resolve(rootDir);
  if (looksLikeAbsoluteSystemPath(rawPath)) {
    return resolve(rawPath);
  }
  let rooted = rawPath;
  while (rooted.startsWith("/") || rooted.startsWith("\\")) {
    rooted = rooted.slice(1);
  }
  return resolve(absRoot, rooted || ".");
}

export function applyEditBlock(block: EditBlock, rootDir: string): ApplyResult {
  const absRoot = resolve(rootDir);
  const absTarget = resolveEditPath(rootDir, block.path);
  // Refuse paths that escape rootDir. `resolve` normalizes `..`, so
  // relative-path containment avoids prefix false positives.
  if (!pathIsUnder(absTarget, absRoot)) {
    return {
      path: block.path,
      status: "path-escape",
      message: `resolved path ${absTarget} is outside rootDir ${absRoot}`,
    };
  }

  const searchEmpty = block.search.length === 0;

  // Branch on intent first so each path makes exactly one `open` call
  // — keeps CodeQL's flow analyser from tripping over a check→use
  // chain across two opens (js/file-system-race).
  if (searchEmpty) {
    try {
      mkdirSync(dirname(absTarget), { recursive: true });
      const fd = openSync(absTarget, "wx");
      try {
        writeSync(fd, block.replace);
      } finally {
        closeSync(fd);
      }
      return { path: block.path, status: "created" };
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code === "EEXIST") {
        return {
          path: block.path,
          status: "not-found",
          message: "empty SEARCH only creates new files — this file already exists",
        };
      }
      return { path: block.path, status: "error", message: e.message };
    }
  }

  try {
    // Modify path. ENOENT is reported as `file-missing` so the model
    // knows it needs an empty SEARCH to create the file.
    let writeTarget: string;
    try {
      writeTarget = realpathSync(absTarget);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return {
          path: block.path,
          status: "file-missing",
          message: "file does not exist; to create it, use an empty SEARCH block",
        };
      }
      throw err;
    }

    let fd: number | undefined;
    try {
      fd = openSync(writeTarget, "r+");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return {
          path: block.path,
          status: "file-missing",
          message: "file does not exist; to create it, use an empty SEARCH block",
        };
      }
      throw err;
    }

    try {
      const stat = fstatSync(fd);
      const inBuf = Buffer.alloc(stat.size);
      let readBytes = 0;
      while (readBytes < stat.size) {
        const n = readSync(fd, inBuf, readBytes, stat.size - readBytes, readBytes);
        if (n <= 0) break;
        readBytes += n;
      }
      const { text: content, encoding } = decodeFileBuffer(inBuf.subarray(0, readBytes));
      const le = lineEndingOf(content);
      const m = locateSingleMatch(content, block.search, block.replace, le);
      if ("failure" in m) {
        return {
          path: block.path,
          status: "not-found",
          message:
            m.failure === "ambiguous"
              ? "SEARCH text appears multiple times; include more context to disambiguate"
              : "SEARCH text does not match the current file content exactly",
        };
      }
      // Apply one unambiguous occurrence. Auto-expanding to replace-all is
      // a footgun when the same string legitimately appears in several
      // unrelated places.
      const { adaptedSearch, adaptedReplace, firstIdx } = m.match;
      const replaced = `${content.slice(0, firstIdx)}${adaptedReplace}${content.slice(firstIdx + adaptedSearch.length)}`;
      closeSync(fd);
      fd = undefined;
      atomicReplaceFileSync(writeTarget, encodeFile(replaced, encoding), stat.mode);
      return { path: block.path, status: "applied" };
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  } catch (err) {
    return { path: block.path, status: "error", message: (err as Error).message };
  }
}

export function applyEditBlocks(blocks: EditBlock[], rootDir: string): ApplyResult[] {
  return blocks.map((b) => applyEditBlock(b, rootDir));
}

export function toWholeFileEditBlock(path: string, content: string, rootDir: string): EditBlock {
  const abs = resolveEditPath(rootDir, path);
  let search = "";
  if (existsSync(abs)) {
    try {
      search = decodeFileBuffer(readFileSync(abs)).text;
    } catch {
      search = "";
    }
  }
  return { path, search, replace: content, offset: 0 };
}

export function lineEndingOf(text: string): string {
  return text.includes("\r\n") ? "\r\n" : "\n";
}

export interface SingleMatch {
  adaptedSearch: string;
  adaptedReplace: string;
  firstIdx: number;
}

export type SingleMatchFailure = "not-found" | "ambiguous";

/** Locate the unique occurrence of `search` (line-endings adapted to `le`) —
 *  adapted strings + index, or the failure reason. Shared by the edit gate
 *  and the edit_file/multi_edit tools so both enforce identical semantics. */
export function locateSingleMatch(
  text: string,
  search: string,
  replace: string,
  le: string,
): { match: SingleMatch } | { failure: SingleMatchFailure } {
  const adaptedSearch = search.replace(/\r?\n/g, le);
  const adaptedReplace = replace.replace(/\r?\n/g, le);
  const firstIdx = text.indexOf(adaptedSearch);
  if (firstIdx < 0) return { failure: "not-found" };
  const nextIdx = text.indexOf(adaptedSearch, firstIdx + 1);
  if (nextIdx >= 0) return { failure: "ambiguous" };
  return { match: { adaptedSearch, adaptedReplace, firstIdx } };
}
