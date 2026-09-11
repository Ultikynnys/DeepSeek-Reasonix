/** Hardcoded — fetching this list at runtime would make `mcp list` flaky offline / behind proxies. */

export interface CatalogEntry {
  /** Short name, used as the namespace prefix when suggested. */
  name: string;
  /** One-line description shown in `reasonix mcp list`. */
  summary: string;
  /** npm package id (for `npx -y <pkg>`). */
  package: string;
  /** Extra args the user must supply (e.g. a directory path). */
  userArgs?: string;
  /** Notes the user needs to know — shown dimmed. */
  note?: string;
}

/** Canonical stdio launcher for a catalog entry — `npx -y <pkg>`. Shared by
 *  add_mcp_server's spec builder and the desktop playwright-configure flow. */
export function catalogStdioCommand(entry: CatalogEntry): { command: string; args: string[] } {
  return { command: "npx", args: ["-y", entry.package] };
}

// Every entry below is verified to exist on npm as of this release.
// `fetch` and `sqlite` are deliberately *absent* — their reference
// servers are Python-only (`pip install mcp-server-fetch`), so a Node
// user running `npx -y @modelcontextprotocol/server-fetch` hits a 404
// from the npm registry. We'd rather ship a smaller list that always
// works than a longer list where two options silently 404 on the user.
export const MCP_CATALOG: CatalogEntry[] = [
  {
    name: "filesystem",
    summary: "read/write/search files inside a sandboxed directory",
    package: "@modelcontextprotocol/server-filesystem",
    userArgs: "<dir>",
    note: "the directory is a hard sandbox — the server refuses access outside it",
  },
  {
    name: "memory",
    summary: "persistent key-value memory across sessions",
    package: "@modelcontextprotocol/server-memory",
  },
  {
    name: "github",
    summary: "read issues, PRs, code search (needs GITHUB_PERSONAL_ACCESS_TOKEN)",
    package: "@modelcontextprotocol/server-github",
    note: "set GITHUB_PERSONAL_ACCESS_TOKEN in your env before spawning",
  },
  {
    name: "puppeteer",
    summary: "browser automation — take screenshots, click, type",
    package: "@modelcontextprotocol/server-puppeteer",
    note: "downloads Chromium on first run (~200 MB)",
  },
  {
    name: "everything",
    summary: "official test server — exercises every MCP feature",
    package: "@modelcontextprotocol/server-everything",
    note: "useful for debugging your Reasonix setup",
  },
  {
    name: "playwright",
    summary:
      "Microsoft Playwright MCP: managed Chrome, Firefox, WebKit, and Edge automation via accessibility snapshots",
    package: "@playwright/mcp",
    note: "use --extension only for existing Chrome/Edge tabs; use --cdp-endpoint for other Chromium browsers exposing CDP; Reasonix bootstraps durable browser tooling automatically",
  },
  {
    name: "outlook_mail",
    summary: "Outlook and Hotmail mail with Microsoft device-code authentication",
    package: "@softeria/ms-365-mcp-server@0.85.0",
    userArgs: "--preset mail",
    note: "Reasonix keeps authentication controls in the desktop UI and exposes only mail operations to the model",
  },
];
