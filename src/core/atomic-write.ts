import { randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  copyFileSync,
  fsyncSync,
  openSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { dirname } from "node:path";

export interface AtomicWriteFs {
  writeFileSync: typeof writeFileSync;
  chmodSync: typeof chmodSync;
  renameSync: typeof renameSync;
  copyFileSync: typeof copyFileSync;
  unlinkSync: typeof unlinkSync;
}

const defaultFs: AtomicWriteFs = {
  writeFileSync,
  chmodSync,
  renameSync,
  copyFileSync,
  unlinkSync,
};

/** Collision-safe sibling tmp path for the write-then-rename pattern. */
export function tmpSiblingPath(path: string): string {
  return `${path}.${randomBytes(8).toString("hex")}.tmp`;
}

/** Atomic write with EXDEV fallback — Windows OneDrive / reparse points refuse rename, fixes #1738. */
export function atomicWriteSync(
  path: string,
  body: string,
  tmp: string,
  mode = 0o600,
  fs: AtomicWriteFs = defaultFs,
): void {
  try {
    fs.writeFileSync(tmp, body, "utf8");
    try {
      fs.chmodSync(tmp, mode);
    } catch {
      void 0; /* platform without chmod */
    }
    try {
      fs.renameSync(tmp, path);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EXDEV") throw err;
      fs.copyFileSync(tmp, path);
      try {
        fs.chmodSync(path, mode);
      } catch {
        void 0; /* platform without chmod */
      }
    }
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      void 0; /* tmp may already be gone or never existed */
    }
    throw err;
  }
  try {
    fs.unlinkSync(tmp);
  } catch {
    void 0; /* rename consumed it on the happy path; only present after EXDEV fallback */
  }
}

function writeAllSync(fd: number, buf: Buffer): void {
  let written = 0;
  while (written < buf.length) {
    const n = writeSync(fd, buf, written, buf.length - written, written);
    if (n <= 0) throw new Error("write returned 0 bytes before completing");
    written += n;
  }
}

function fsyncDirectoryBestEffort(path: string): void {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    fsyncSync(fd);
  } catch {
    void 0; /* directory fsync is best-effort across platforms */
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** Durable atomic write for a raw Buffer: writes a sibling tmp, fsyncs both the
 *  file and its directory, then renames over `path`. Used by the edit gate so a
 *  landed SEARCH/REPLACE is durable before the model is told it applied. */
export function atomicReplaceFileSync(path: string, buf: Buffer, mode: number): void {
  const tmp = tmpSiblingPath(path);
  const permissions = mode & 0o7777;
  let fd: number | undefined;
  try {
    fd = openSync(tmp, "wx", permissions);
    writeAllSync(fd, buf);
    try {
      chmodSync(tmp, permissions);
    } catch {
      void 0; /* preserve mode when the platform allows it */
    }
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(tmp, path);
    fsyncDirectoryBestEffort(dirname(path));
  } catch (err) {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        void 0; /* fd may already be closed after a prior failure */
      }
    }
    try {
      unlinkSync(tmp);
    } catch {
      void 0; /* tmp may not exist */
    }
    throw err;
  }
}
