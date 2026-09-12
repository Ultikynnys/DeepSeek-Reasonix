import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const here = fileURLToPath(new URL(".", import.meta.url));
const maxForks = process.env.CI ? 4 : 8;

export default defineConfig({
  resolve: {
    alias: {
      "@": resolve(here, "src"),
      react: resolve(here, "node_modules/react"),
      "react-dom": resolve(here, "node_modules/react-dom"),
      "react-dom/client": resolve(here, "node_modules/react-dom/client.js"),
      "lucide-react": resolve(here, "tests/mocks/lucide-react.ts"),
      "@tauri-apps/api/core": resolve(here, "tests/mocks/tauri-api-core.ts"),
      "@tauri-apps/api/event": resolve(here, "tests/mocks/tauri-api-event.ts"),
      "@tauri-apps/api/window": resolve(here, "tests/mocks/tauri-api-window.ts"),
      "@tauri-apps/api/webview": resolve(here, "tests/mocks/tauri-api-webview.ts"),
      "@tauri-apps/plugin-dialog": resolve(here, "tests/mocks/tauri-plugin-dialog.ts"),
      "@tauri-apps/plugin-notification": resolve(here, "tests/mocks/tauri-plugin-notification.ts"),
      "@tauri-apps/plugin-process": resolve(here, "tests/mocks/tauri-plugin-process.ts"),
      "@tauri-apps/plugin-updater": resolve(here, "tests/mocks/tauri-plugin-updater.ts"),
      "@tauri-apps/plugin-opener": resolve(here, "tests/mocks/tauri-plugin-opener.ts"),
    },
  },
  test: {
    include: [
      "tests/**/*.test.ts",
      "tests/**/*.test.tsx",
      "packages/core-utils/tests/**/*.test.ts",
      "desktop/src/**/*.test.ts",
      "desktop/src/**/*.test.tsx",
    ],
    setupFiles: [],
    environment: "node",
    globals: false,
    // Forks pool: per-file process isolation keeps tokenizer BPE, tree-sitter
    // WASMs, and sqlite native handles from accumulating in one shared heap.
    // Keep CI lower than local runs: Windows coverage at eight forks can starve
    // Vitest's worker RPC and time out onTaskUpdate even after tests pass.
    pool: "forks",
    poolOptions: {
      forks: { maxForks, minForks: 1 },
    },
    // One retry absorbs Windows scheduler hiccups in jobs.test.ts / loop.test.ts /
    // bundle-smoke (real spawns + tokenizer cold load). A real failure still re-fails.
    retry: 1,
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "json-summary"],
      include: ["src/**"],
      exclude: ["src/**/*.test.ts"],
    },
  },
});
