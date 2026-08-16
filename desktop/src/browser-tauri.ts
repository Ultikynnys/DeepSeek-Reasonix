/**
 * Browser-only stand-in for Tauri's `window.__TAURI_INTERNALS__` so the exact
 * same desktop frontend runs in a plain browser tab via `dev:browser`.
 *
 * Under the real Tauri host this module is a no-op — `__TAURI_INTERNALS__`
 * already exists and nothing here runs. Outside Tauri it installs:
 *
 *  - `transformCallback` / `unregisterCallback` / `runCallback` — the callback
 *    registry that `@tauri-apps/api` uses to marshal event handlers.
 *  - `invoke` — routes the commands the UI actually calls:
 *      * `rpc_spawn` / `rpc_send` / `rpc_kill` → the WebSocket bridge
 *        (desktop/plugins/browser-bridge.ts), which spawns the real Node
 *        daemon and pipes its stdout/stderr the way rpc.rs does.
 *      * `plugin:event|listen` / `unlisten` → a local event bus fed by bridge
 *        messages (`rpc:event`, `rpc:stderr`, `rpc:exit`).
 *      * updater / notification / opener / process / dialog / window / webview
 *        commands → browser equivalents or safe no-ops.
 *  - `metadata` + `convertFileSrc` — so `getCurrentWindow()` and image
 *    thumbnail URL building don't throw.
 *
 * Browser limitations (deliberate): local file paths can't be served by a
 * browser, so `convertFileSrc` returns the raw path (thumbnails won't render);
 * file-open dialogs return null (cancel); drag-drop overlay is inert.
 */

type Callback = (data: unknown) => void;

const callbacks = new Map<number, { fn: Callback; once: boolean }>();
const listeners = new Map<string, Set<number>>();
let nextCallbackId = 1;
let nextEventId = 1;

function transformCallback(callback: Callback, once = false): number {
  const id = nextCallbackId++;
  callbacks.set(id, { fn: callback, once });
  return id;
}

function unregisterCallback(id: number): void {
  callbacks.delete(id);
}

function runCallback(id: number, data: unknown): void {
  const entry = callbacks.get(id);
  if (!entry) {
    console.warn(`[browser-tauri] callback ${id} not found (page reloaded?)`);
    return;
  }
  if (entry.once) callbacks.delete(id);
  entry.fn(data);
}

function unregisterListener(_event: string, id: number): void {
  unregisterCallback(id);
  for (const ids of listeners.values()) ids.delete(id);
}

/** Bridge endpoint — keep in sync with desktop/plugins/browser-bridge.ts. */
const BRIDGE_URL = "ws://127.0.0.1:1421/";

let socket: WebSocket | null = null;
let wsOpen: Promise<void> | null = null;
let wsCloseWaiters: Array<() => void> = [];

function connectBridge(): void {
  const open = new Promise<void>((resolve) => {
    const ws = new WebSocket(BRIDGE_URL);
    socket = ws;
    ws.onopen = () => {
      console.info("[browser-tauri] bridge connected");
      resolve();
      for (const w of wsCloseWaiters) w();
      wsCloseWaiters = [];
    };
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(String(ev.data)) as { event: string; payload: unknown };
        dispatch(msg.event, msg.payload);
      } catch (err) {
        console.error("[browser-tauri] bad bridge message", err);
      }
    };
    ws.onclose = () => {
      socket = null;
      // Backoff-reconnect so a daemon/vite restart doesn't strand the tab.
      setTimeout(connectBridge, 1000);
    };
    ws.onerror = () => {
      ws.close();
    };
  });
  wsOpen = open;
}

function waitForBridge(): Promise<void> {
  if (wsOpen) return wsOpen;
  connectBridge();
  return wsOpen ?? Promise.resolve();
}

function dispatch(event: string, payload: unknown): void {
  const ids = listeners.get(event);
  if (!ids || ids.size === 0) return;
  const data = { event, id: nextEventId++, payload };
  for (const id of [...ids]) runCallback(id, data);
}

function wsSend(msg: unknown): void {
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(msg));
  }
}

/** Map a Tauri command name to a browser behavior. */
async function invoke(
  cmd: string,
  args: Record<string, unknown> = {},
  _options?: unknown,
): Promise<unknown> {
  switch (cmd) {
    // ---- RPC bridge ----
    case "rpc_spawn": {
      // Daemon is already up — the bridge spawns it at vite startup. Just wait
      // for the socket so the follow-up desktop_resync isn't sent into the void.
      await waitForBridge();
      return undefined;
    }
    case "rpc_send": {
      await waitForBridge();
      wsSend({ type: "rpc_send", line: args.line });
      return undefined;
    }
    case "rpc_kill": {
      wsSend({ type: "rpc_kill" });
      return undefined;
    }
    case "write_text_file": {
      // Export-to-file (App.tsx saveDialog + write_text_file): trigger a real
      // browser download instead of touching the (browser-invisible) fs.
      const path = String(args.path ?? "download.md");
      const content = String(args.content ?? "");
      downloadBlob(content, path.split(/[\\/]/).pop() ?? "download.md");
      return undefined;
    }

    // ---- Event plugin (local bus, fed by bridge messages) ----
    case "plugin:event|listen": {
      const event = String(args.event ?? "");
      const handler = Number(args.handler);
      if (!event || !handler) return null;
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event)?.add(handler);
      return handler; // doubles as the unlisten eventId (mocks.js behavior)
    }
    case "plugin:event|unlisten": {
      const event = String(args.event ?? "");
      const eventId = Number(args.eventId);
      const ids = listeners.get(event);
      if (ids) ids.delete(eventId);
      unregisterCallback(eventId);
      return null;
    }
    case "plugin:event|emit": {
      dispatch(String(args.event ?? ""), args.payload);
      return null;
    }

    // ---- Updater: never auto-update in a browser tab ----
    case "plugin:updater|check":
      return null;
    case "plugin:updater|install":
    case "plugin:updater|download":
      return undefined;

    // ---- Notifications → Web Notification API ----
    case "plugin:notification|is_permission_granted":
      return "Notification" in window && Notification.permission === "granted";
    case "plugin:notification|request_permission": {
      if (!("Notification" in window)) return "denied";
      return await Notification.requestPermission();
    }
    case "plugin:notification|notify": {
      if ("Notification" in window && Notification.permission === "granted") {
        const options = (args.options ?? {}) as { title?: string; body?: string; icon?: string };
        try {
          new Notification(options.title ?? "Reasonix", {
            body: options.body,
            icon: options.icon,
          });
        } catch {
          /* notification too big / permission raced — non-fatal */
        }
      }
      return undefined;
    }
    case "plugin:notification|cancel":
    case "plugin:notification|register_action_types":
    case "plugin:notification|create_channel":
    case "plugin:notification|delete_channel":
      return undefined;

    // ---- Opener ----
    case "plugin:opener|open_url": {
      const url = String(args.url ?? "");
      if (url) window.open(url, "_blank", "noopener");
      return undefined;
    }
    case "plugin:opener|open_path": {
      // Browser can't open arbitrary local paths; fall back to a page anchor.
      console.warn("[browser-tauri] open_path unavailable in browser:", args.path);
      return null;
    }
    case "plugin:opener|reveal_item_in_dir":
      return null;

    // ---- Process ----
    case "plugin:process|relaunch":
      window.location.reload();
      return undefined;
    case "plugin:process|exit":
      window.close();
      return undefined;

    // ---- Dialog: open cancels (no browser fs access); save fakes a path ----
    case "plugin:dialog|open":
      return null;
    case "plugin:dialog|save": {
      const options = (args.options ?? {}) as { defaultPath?: string };
      return options.defaultPath ?? "download.md";
    }
    case "plugin:dialog|message": {
      window.alert(String(args.message ?? ""));
      return undefined;
    }
    case "plugin:dialog|ask": {
      return window.confirm(String(args.message ?? ""));
    }
    case "plugin:dialog|confirm":
      return window.confirm(String(args.message ?? ""));
    case "plugin:dialog|show":
      return null;

    // ---- Window: read-only queries return browser-truthy defaults ----
    case "plugin:window|is_focused":
    case "plugin:window|is_visible":
    case "plugin:window|is_decorated":
    case "plugin:window|is_resizable":
    case "plugin:window|is_maximizable":
    case "plugin:window|is_minimizable":
    case "plugin:window|is_closable":
    case "plugin:window|is_enabled":
      return true;
    case "plugin:window|is_maximized":
    case "plugin:window|is_minimized":
    case "plugin:window|is_fullscreen":
    case "plugin:window|is_always_on_top":
      return false;
    case "plugin:window|title":
      return document.title;
    case "plugin:window|theme":
      return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
    case "plugin:window|set_title": {
      document.title = String(args.title ?? "");
      return undefined;
    }
    case "plugin:window|scale_factor":
      return window.devicePixelRatio;
    case "plugin:window|inner_size":
    case "plugin:window|outer_size":
      return { width: window.innerWidth, height: window.innerHeight };
    case "plugin:window|inner_position":
    case "plugin:window|outer_position":
      return { x: window.screenX, y: window.screenY };
    case "plugin:window|close":
      window.close();
      return undefined;
    case "plugin:window|minimize":
    case "plugin:window|maximize":
    case "plugin:window|unminimize":
    case "plugin:window|unmaximize":
    case "plugin:window|toggle_maximize":
    case "plugin:window|center":
    case "plugin:window|start_dragging":
    case "plugin:window|hide":
    case "plugin:window|show":
    case "plugin:window|set_focus":
    case "plugin:window|set_resizable":
    case "plugin:window|set_maximizable":
    case "plugin:window|set_minimizable":
    case "plugin:window|set_closable":
    case "plugin:window|set_enabled":
    case "plugin:window|set_always_on_top":
    case "plugin:window|set_size":
    case "plugin:window|set_position":
    case "plugin:window|set_fullscreen":
      return undefined;

    // ---- Webview (drag-drop): resolve an unlisten fn so cleanup is safe ----
    case "plugin:webview|on_drag_drop_event":
      return () => undefined;
    case "plugin:webview|set_background_color":
    case "plugin:webview|set_zoom":
    case "plugin:webview|set_focus":
    case "plugin:webview|show":
    case "plugin:webview|hide":
      return undefined;

    // ---- Window-state plugin persistence: nothing to persist ----
    case "plugin:window-state|save_window_state":
    case "plugin:window-state|restore_state":
      return null;

    default:
      console.warn(`[browser-tauri] unhandled command "${cmd}" — resolved null`, args);
      return null;
  }
}

function downloadBlob(content: string, filename: string): void {
  const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/** Install only when running outside the real Tauri host. */
export function installBrowserTauri(): void {
  if ((window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__) return;

  const internals = window as unknown as {
    __TAURI_INTERNALS__: Record<string, unknown>;
    __TAURI_EVENT_PLUGIN_INTERNALS__: Record<string, unknown>;
  };
  internals.__TAURI_INTERNALS__ = {
    invoke,
    transformCallback,
    unregisterCallback,
    runCallback,
    callbacks,
    metadata: {
      currentWindow: { label: "main" },
      currentWebview: { windowLabel: "main", label: "main" },
    },
    convertFileSrc: (filePath: string, _protocol?: string) => filePath,
  };
  internals.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener };

  connectBridge();
}

installBrowserTauri();
