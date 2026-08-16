// Browser dev mode: boots Vite with REASONIX_BROWSER=1 so the browser-bridge
// plugin (desktop/plugins/browser-bridge.ts) spawns the Node daemon and pipes
// it to the tab over WebSocket. The Tauri shim in src/browser-tauri.ts makes
// the same frontend run without the Rust host.
//
// Usage: npm --prefix desktop run dev:browser  →  open http://127.0.0.1:1420
process.env.REASONIX_BROWSER = "1";

const { createServer } = await import("vite");

const server = await createServer({
  configFile: "vite.config.ts",
});

await server.listen();
server.printUrls();
