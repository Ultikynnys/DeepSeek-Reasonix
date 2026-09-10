/** Post-build smoke — confirm bundled `dist/{index,cli/index}.js` resolves the tokenizer data file at package-root. */

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const LIB_BUNDLE = resolve("dist/index.js");
const CLI_BUNDLE = resolve("dist/cli/index.js");

describe("bundled dist — tokenizer path resolution", () => {
  it("dist/index.js resolves the tokenizer data file at package-root data/", () => {
    expect(existsSync(LIB_BUNDLE), "dist/index.js is missing — run npm run build first").toBe(true);
    // truncateForModelByTokens internally calls countTokens when the
    // input exceeds the fast-path threshold, which forces the
    // tokenizer's lazy data-file load. If resolveDataPath() lands on
    // a non-existent path (the 0.5.4 regression) this crashes with
    // ENOENT and the spawned process exits non-zero.
    // ESM dynamic imports on Windows require `file://` URLs, not bare
    // absolute paths (which Node's ESM loader rejects as an unknown
    // protocol). pathToFileURL handles the cross-platform form.
    const libUrl = pathToFileURL(LIB_BUNDLE).href;
    const result = spawnSync(
      "node",
      [
        "--input-type=module",
        "-e",
        `import { truncateForModelByTokens } from "${libUrl}";
         const s = "hello world ".repeat(500);
         const out = truncateForModelByTokens(s, 100);
         console.log(JSON.stringify({ ok: true, len: out.length }));`,
      ],
      { encoding: "utf8", timeout: 30_000 },
    );
    expect(result.status).toBe(0);
    expect(result.stderr).not.toMatch(/deepseek-tokenizer\.json\.gz/);
    expect(result.stderr).not.toMatch(/ENOENT/);
    expect(result.stdout).toMatch(/"ok":true/);
  });

  it("dist/cli/* inlines runtime deps so the desktop sidecar can run without node_modules", async () => {
    expect(existsSync(CLI_BUNDLE), "dist/cli/index.js is missing — run npm run build first").toBe(
      true,
    );
    const { readdirSync, readFileSync } = await import("node:fs");
    const distDir = resolve("dist/cli");
    const jsFiles = readdirSync(distDir).filter((f) => f.endsWith(".js"));
    const leakedImports = jsFiles.flatMap((f) => {
      const body = readFileSync(resolve(distDir, f), "utf8");
      const hits: string[] = [];
      for (const pkg of ["commander", "ink", "undici"]) {
        if (new RegExp(`from\\s*["']${pkg}["']`).test(body)) hits.push(`${f}:${pkg}`);
      }
      return hits;
    });
    expect(
      leakedImports,
      `dist/cli/*.js still imports runtime deps from node_modules: ${leakedImports.join(", ")}`,
    ).toEqual([]);
  });

  it("dist/cli/index.js loads tokenizer before the first API fetch", () => {
    expect(existsSync(CLI_BUNDLE), "dist/cli/index.js is missing — run npm run build first").toBe(
      true,
    );
    // Spawn the desktop backend pointed at a bogus local address that fails
    // fetch fast. In runTurn(), preflight's estimateRequestTokens runs BEFORE
    // client.chat — so if the bundled layout can't find the tokenizer data,
    // we see ENOENT in stderr even though the fetch never happens. If
    // tokenizer loads fine, we see a connection error instead (and that's OK
    // — we're not testing the network path, only that the tokenizer path
    // resolution works from dist/cli/). The daemon is a long-running server,
    // so the spawn is killed by the timeout once the turn has failed fast;
    // the assertions run on the collected output.
    const smokeDir = mkdtempSync(join(tmpdir(), "reasonix-smoke-"));
    // Isolate the daemon's home: it lists + echoes real session transcripts
    // into stdout, and a transcript that happens to mention the tokenizer
    // data path would trip the "must not match" assertions below.
    const smokeHome = mkdtempSync(join(tmpdir(), "reasonix-smoke-home-"));
    const result = spawnSync("node", [CLI_BUNDLE, "desktop", "--dir", smokeDir], {
      encoding: "utf8",
      timeout: 10_000,
      // One user_input turn — the same message the Tauri shell sends.
      input: '{"cmd":"user_input","text":"hi"}\n',
      env: {
        ...process.env,
        USERPROFILE: smokeHome,
        HOME: smokeHome,
        DEEPSEEK_API_KEY: "sk-smoke-test-bogus",
        // Fail-fast fetch target: the :1 port is almost never open,
        // so we get connection-refused within ~1ms instead of the
        // client's 120s timeout waiting on api.deepseek.com.
        DEEPSEEK_BASE_URL: "http://127.0.0.1:1",
      },
    });
    const combined = `${result.stdout}\n${result.stderr}`;
    // The crucial assertion: bundle must not crash on the tokenizer
    // path. Connection errors to 127.0.0.1:1 are expected and fine.
    expect(combined).not.toMatch(/deepseek-tokenizer\.json\.gz/);
    // Also not a missing-module style ENOENT (network errors are
    // ECONNREFUSED or fetch failure, never ENOENT).
    expect(combined).not.toMatch(/ENOENT.*tokenizer/i);
    // The daemon must have actually responded (event JSON on stdout) —
    // a commander error or instant crash would produce no events.
    expect(result.stdout).toMatch(/"type":\s*"\$/);
  });
});

describe("base install stays lightweight — external Playwright components are opt-in", () => {
  it("lists no Playwright dependency in any manifest", () => {
    const offenders: string[] = [];
    for (const rel of ["package.json", "desktop/package.json"]) {
      const path = resolve(rel);
      if (!existsSync(path)) continue;
      const pkg = JSON.parse(readFileSync(path, "utf8")) as Record<string, Record<string, string>>;
      for (const field of [
        "dependencies",
        "devDependencies",
        "optionalDependencies",
        "peerDependencies",
      ]) {
        for (const name of Object.keys(pkg[field] ?? {})) {
          if (
            name === "playwright" ||
            name === "playwright-core" ||
            name.startsWith("@playwright/")
          ) {
            offenders.push(`${rel}:${field}:${name}`);
          }
        }
      }
    }
    expect(
      offenders,
      `Playwright packages must stay opt-in (downloaded on demand): ${offenders.join(", ")}`,
    ).toEqual([]);
  });

  it("records no Playwright package in the lockfiles", () => {
    const offenders: string[] = [];
    for (const rel of ["package-lock.json", "desktop/package-lock.json"]) {
      const path = resolve(rel);
      if (!existsSync(path)) continue;
      const body = readFileSync(path, "utf8");
      for (const needle of ["@playwright/mcp", "@playwright/test", "playwright-core"]) {
        if (body.includes(needle)) offenders.push(`${rel}:${needle}`);
      }
    }
    expect(offenders, `Playwright packages leaked into lockfiles: ${offenders.join(", ")}`).toEqual(
      [],
    );
  });

  it("packs no browser-extension or browser-cache resource in the Tauri bundles", () => {
    for (const rel of [
      "desktop/src-tauri/tauri.conf.json",
      "desktop/src-tauri/tauri.windows.conf.json",
    ]) {
      const path = resolve(rel);
      if (!existsSync(path)) continue;
      const body = readFileSync(path, "utf8");
      expect(body, `${rel} must not bundle the Playwright extension`).not.toMatch(
        /playwright-extension/,
      );
      expect(body, `${rel} must not bundle a browser cache`).not.toMatch(/ms-playwright/);
    }
  });

  it("ships no bundler script or npm script that downloads Playwright artifacts", () => {
    expect(existsSync(resolve("desktop/scripts/bundle-playwright-extension.mjs"))).toBe(false);
    const pkg = readFileSync(resolve("desktop/package.json"), "utf8");
    expect(pkg).not.toMatch(/bundle:extension/);
  });
});
