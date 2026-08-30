// Copy the ripgrep binary into dist/ so the shipped harness (desktop resources
// bundle dist/, not node_modules) always finds rg. Windows-only: @vscode/ripgrep
// downloads a prebuilt rg.exe for win32; other platforms no-op and fall back to
// whatever is on PATH.
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";

const TARGET = "dist/rg/rg.exe";

if (process.platform !== "win32") {
  console.log("skip ripgrep copy — not Windows; search_content falls back to PATH rg");
  process.exit(0);
}

let source = "node_modules/@vscode/ripgrep-win32-x64/bin/rg.exe";
try {
  // Canonical resolution — the platform package path (win32-x64) is what
  // @vscode/ripgrep's rgPath export points at.
  const require = createRequire(import.meta.url);
  source = require("@vscode/ripgrep").rgPath;
} catch {
  // Fall back to the known layout if the package main can't be loaded.
}

if (!existsSync(source)) {
  console.warn(`ripgrep binary not found at ${source} — search_content falls back to PATH rg`);
  process.exit(0);
}

const dst = resolve(TARGET);
mkdirSync(dirname(dst), { recursive: true });
copyFileSync(resolve(source), dst);
console.log(`copied ${source} → ${dst}`);
