/** Binary-file detection shared by the filesystem + search tools. */

/** Sniff the first 8 KiB for a NUL byte — catches binary files whose extension lied. UTF-16 (rare in source) is an accepted false positive. */
export function looksBinary(buf: Buffer): boolean {
  const end = Math.min(buf.length, 8192);
  for (let i = 0; i < end; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}
