import { invoke } from "@tauri-apps/api/core";
import { openPath } from "@tauri-apps/plugin-opener";
import { useMemo, useRef, useState } from "react";
import type { ChangeEvent } from "react";
import type { SessionFile, Settings, UsageStats } from "../App";
import { t, useLang } from "../i18n";
import { I } from "../icons";
import type { McpSpecInfo, MemoryDetail, MemoryEntryInfo } from "../protocol";
import { PanelErrorBoundary } from "./error-boundary";

type Tab = "files" | "tools" | "memory" | "rules";

/** Fallback until the sidecar reports the real cap via $ctx_breakdown — the V4 context
 *  window is 300K (DEEPSEEK_CONTEXT_TOKENS); never show the old 1M API ceiling. */
const CONTEXT_MAX_TOKENS = 300_000;

/** 1_234_567 → "1235K" — used for compaction-limit labels on the meter. */
function fmtCompact(n: number): string {
  return n >= 1000 ? `${Math.round(n / 1000)}K` : String(Math.round(n));
}

export function ContextPanel({
  settings,
  usage,
  mcpSpecs,
  mcpBridged,
  sessionFiles,
  memory,
  memoryDetail,
  memoryResult,
  onReadMemory,
  onWriteMemory,
  onDeleteMemory,
  onExportMemories,
  onImportMemories,
  onDismissMemoryResult,
}: {
  settings: Settings | null;
  usage: UsageStats;
  mcpSpecs: McpSpecInfo[];
  mcpBridged: boolean;
  sessionFiles: SessionFile[];
  memory: MemoryEntryInfo[];
  memoryDetail: MemoryDetail | null;
  memoryResult: { ok: boolean; message: string } | null;
  onReadMemory: (path: string) => void;
  onWriteMemory: (scope: "global" | "project", name: string, description: string, body: string) => void;
  onDeleteMemory: (path: string) => void;
  onExportMemories: () => void;
  onImportMemories: (json: string) => void;
  onDismissMemoryResult: () => void;
}) {
  useLang();
  const [tab, setTab] = useState<Tab>("files");
  const reserved = usage.reservedTokens;
  const lastHit = usage.lastCallCacheHit ?? 0;
  const lastMiss = usage.lastCallCacheMiss ?? 0;
  const observedLog = Math.max(0, lastHit + lastMiss - reserved);
  const logTokens = Math.max(usage.liveLogTokens, observedLog);
  const cached = Math.min(logTokens, Math.max(0, lastHit - reserved));
  const used = Math.max(0, logTokens - cached);
  // Real per-model cap from the sidecar (300K for V4) — the fallback below
  // matches it so the bar is never wrong while the first snapshot is in flight.
  const ctxMax = usage.ctxMax ?? CONTEXT_MAX_TOKENS;
  const reservedPct = Math.min(100, (reserved / ctxMax) * 100);
  const usedPct = Math.min(100, (used / ctxMax) * 100);
  const cachedPct = Math.min(100, (cached / ctxMax) * 100);
  const free = Math.max(0, ctxMax - reserved - used - cached);
  return (
    <aside className="ctx">
      <div className="ctx-tabs">
        <div className="ctx-tab" data-active={tab === "files"} onClick={() => setTab("files")}>
          {t("contextPanel.filesTab")}
        </div>
        <div className="ctx-tab" data-active={tab === "tools"} onClick={() => setTab("tools")}>
          {t("contextPanel.toolsTab")}
        </div>
        <div className="ctx-tab" data-active={tab === "memory"} onClick={() => setTab("memory")}>
          {t("contextPanel.memoryTab")}
        </div>
        <div className="ctx-tab" data-active={tab === "rules"} onClick={() => setTab("rules")}>
          {t("contextPanel.rulesTab")}
        </div>
      </div>

      <div className="ctx-body">
        <div className="ctx-block">
          <div className="h">
            <span>{t("contextPanel.contextTokens")}</span>
            <span className="right">
              {(reserved + used + cached).toLocaleString()} /{" "}
              {ctxMax.toLocaleString()}
            </span>
          </div>
          <div className="meter">
            <span className="rsvd" style={{ width: `${reservedPct}%` }} />
            <span className="cached" style={{ width: `${cachedPct}%` }} />
            <span className="used" style={{ width: `${usedPct}%` }} />
            {/* Auto-compaction limits (context-manager.ts): fold 75% / forced summary 80% */}
            <span
              className="meter-tick fold"
              style={{ left: "75%" }}
              title={t("contextPanel.foldTick", {
                tokens: fmtCompact(ctxMax * 0.75),
              })}
            />
            <span
              className="meter-tick force"
              style={{ left: "80%" }}
              title={t("contextPanel.forceTick", {
                tokens: fmtCompact(ctxMax * 0.8),
              })}
            />
          </div>
          <div className="legend">
            <span className="l">
              <span className="sw r" />
              {t("contextPanel.reservedKey")} <span className="v">{reserved.toLocaleString()}</span>
            </span>
            <span className="l">
              <span className="sw c" />
              {t("contextPanel.cacheKey")} <span className="v">{cached.toLocaleString()}</span>
            </span>
            <span className="l">
              <span className="sw u" />
              {t("contextPanel.usedKey")} <span className="v">{used.toLocaleString()}</span>
            </span>
            <span className="l">
              {t("contextPanel.freeKey")} <span className="v">{free.toLocaleString()}</span>
            </span>
            <span className="l">
              <span className="sw z" />
              {t("contextPanel.compactionAt", {
                fold: fmtCompact(ctxMax * 0.75),
                force: fmtCompact(ctxMax * 0.8),
              })}
            </span>
          </div>
        </div>

        <PanelErrorBoundary key={tab} label={tab}>
          {tab === "files" && <CtxFiles files={sessionFiles} settings={settings} />}
          {tab === "tools" && <CtxTools specs={mcpSpecs} bridged={mcpBridged} />}
          {tab === "memory" && (
            <CtxMemory
              entries={memory}
              detail={memoryDetail}
              result={memoryResult}
              onRead={onReadMemory}
              onWrite={onWriteMemory}
              onDelete={onDeleteMemory}
              onExport={onExportMemories}
              onImport={onImportMemories}
              onDismissResult={onDismissMemoryResult}
            />
          )}
          {tab === "rules" && <CtxRules settings={settings} />}
        </PanelErrorBoundary>
      </div>
    </aside>
  );
}

type TreeNode =
  | { kind: "dir"; depth: number; name: string; key: string }
  | { kind: "file"; depth: number; name: string; path: string; key: string; status: "c" | "m" };

async function openContextFile(path: string, settings: Settings | null): Promise<void> {
  const workspaceDir = settings?.workspaceDir;
  const isWindows = workspaceDir?.includes("\\") ?? false;
  const sep = isWindows ? "\\" : "/";
  const abs =
    workspaceDir && !/^[a-zA-Z]:[\\/]/.test(path) && !path.startsWith("/")
      ? `${workspaceDir.replace(/[\\/]$/, "")}${sep}${path.replace(/^[\\/]+/, "").replace(/\//g, sep)}`
      : isWindows
        ? path.replace(/\//g, "\\")
        : path;
  // Same contract as openWithEditor: an empty command makes the Rust side
  // auto-detect a code editor (code / cursor / windsurf) so `.ts` files
  // don't fall through to the Windows media player; openPath is only the
  // no-code-editor-at-all last resort.
  try {
    await invoke("open_in_editor", {
      command: settings?.editor?.trim() ?? "",
      path: abs,
      line: null,
    });
  } catch {
    await openPath(abs);
  }
}

function buildSessionTree(files: SessionFile[]): TreeNode[] {
  const sorted = [...files].sort((a, b) =>
    a.path.replace(/\\/g, "/").localeCompare(b.path.replace(/\\/g, "/")),
  );
  const out: TreeNode[] = [];
  const seenDirs = new Set<string>();
  for (const f of sorted) {
    const displayPath = f.path.replace(/\\/g, "/");
    const parts = displayPath.split("/").filter(Boolean);
    if (parts.length === 0) continue;
    let prefix = "";
    for (let i = 0; i < parts.length - 1; i++) {
      const seg = parts[i] ?? "";
      prefix = prefix ? `${prefix}/${seg}` : seg;
      if (!seenDirs.has(prefix)) {
        seenDirs.add(prefix);
        out.push({ kind: "dir", depth: i, name: seg, key: `d:${prefix}` });
      }
    }
    const leaf = parts[parts.length - 1] ?? "";
    out.push({
      kind: "file",
      depth: parts.length - 1,
      name: leaf,
      path: displayPath,
      key: `f:${f.path}`,
      status: f.status,
    });
  }
  return out;
}

function CtxFiles({ files, settings }: { files: SessionFile[]; settings: Settings | null }) {
  const tree = useMemo(() => buildSessionTree(files), [files]);
  return (
    <div className="ctx-block">
      <div className="h">
        <span>{t("contextPanel.filesTitle")}</span>
        <span className="right">
          {files.length === 0 ? "—" : t("contextPanel.filesCount", { count: files.length })}
        </span>
      </div>
      <div className="tree">
        {files.length === 0 ? (
          <div className="ctx-empty">{t("contextPanel.noFilesMsg")}</div>
        ) : (
          tree.map((n) =>
            n.kind === "dir" ? (
              <div
                className="node"
                key={n.key}
                data-d={n.depth}
                data-kind="dir"
                style={{ paddingLeft: 4 + n.depth * 14 }}
              >
                <span className="ico">
                  <I.folder size={12} />
                </span>
                <span className="nm">{n.name}/</span>
              </div>
            ) : (
              <div
                className="node"
                key={n.key}
                data-d={n.depth}
                data-kind="file"
                title={n.path}
                style={{ paddingLeft: 4 + n.depth * 14 }}
                onClick={() => void openContextFile(n.path, settings)}
              >
                <span className="ico">
                  <I.file size={12} />
                </span>
                <span className="node-text">
                  <span className="nm">{n.name}</span>
                  <span className="full-path">{n.path}</span>
                </span>
                <span
                  className="dot"
                  data-s={n.status}
                  title={n.status === "m" ? t("contextPanel.fileModified") : t("contextPanel.fileInContext")}
                />
                <button
                  type="button"
                  className="tree-action"
                  aria-label={t("contextPanel.openFile", { path: n.path })}
                  title={t("contextPanel.openFile", { path: n.path })}
                  onClick={(e) => {
                    e.stopPropagation();
                    void openContextFile(n.path, settings);
                  }}
                >
                  <I.file size={12} />
                </button>
                <button
                  type="button"
                  className="tree-action"
                  aria-label={t("contextPanel.copyPath", { path: n.path })}
                  title={t("contextPanel.copyPath", { path: n.path })}
                  onClick={(e) => {
                    e.stopPropagation();
                    void navigator.clipboard?.writeText(n.path);
                  }}
                >
                  <I.copy size={12} />
                </button>
              </div>
            ),
          )
        )}
      </div>
    </div>
  );
}

function CtxTools({ specs, bridged }: { specs: McpSpecInfo[]; bridged: boolean }) {
  const readyCount = specs.filter((s) => s.status === "connected").length;
  return (
    <div className="ctx-block">
      <div className="h">
        <span>{t("contextPanel.mcpTitle")}</span>
        <span className="right">
          {specs.length === 0
            ? "—"
            : bridged
              ? t("contextPanel.mcpReadyAll", { count: specs.length })
              : t("contextPanel.mcpReadySome", { ready: readyCount, count: specs.length })}
        </span>
      </div>
      {specs.length === 0 ? (
        <div className="ctx-empty">{t("contextPanel.mcpEmpty")}</div>
      ) : (
        specs.map((s) => {
          const dot =
            s.status === "connected"
              ? "ok"
              : s.status === "failed" || s.parseError
                ? "off"
                : "pending";
          const suffix = s.statusReason
            ? ` · ${s.statusReason}`
            : s.status === "connected"
              ? typeof s.toolCount === "number"
                ? ` · ${t("contextPanel.mcpTools", { count: s.toolCount })}`
                : ` · ${t("contextPanel.mcpReady")}`
              : s.status === "handshake"
                ? ` · ${t("contextPanel.mcpConnecting")}`
                : s.status === "disabled"
                  ? ` · ${t("contextPanel.mcpDisabled")}`
                  : s.status === "failed"
                    ? ` · ${t("contextPanel.mcpFailed")}`
                    : ` · ${t("contextPanel.mcpConfigured")}`;
          return (
            <div className="mcp-row" key={s.raw}>
              <span className="ico">
                <I.wrench size={12} />
              </span>
              <div className="body">
                <div className="n">{s.name ?? s.summary}</div>
                <div className="m">
                  {s.transport}
                  {suffix}
                </div>
              </div>
              <span className="status" data-s={dot} />
            </div>
          );
        })
      )}
    </div>
  );
}

function CtxMemory({
  entries,
  detail,
  result,
  onRead,
  onWrite,
  onDelete,
  onExport,
  onImport,
  onDismissResult,
}: {
  entries: MemoryEntryInfo[];
  detail: MemoryDetail | null;
  result: { ok: boolean; message: string } | null;
  onRead: (path: string) => void;
  onWrite: (scope: "global" | "project", name: string, description: string, body: string) => void;
  onDelete: (path: string) => void;
  onExport: () => void;
  onImport: (json: string) => void;
  onDismissResult: () => void;
}) {
  const [composing, setComposing] = useState(false);
  const [name, setName] = useState("");
  const [scope, setScope] = useState<"global" | "project">("project");
  const [body, setBody] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  const submit = (): void => {
    const trimmedName = name.trim();
    const trimmedBody = body.trim();
    if (!trimmedName || !trimmedBody) return;
    onWrite(scope, trimmedName, trimmedBody.slice(0, 150), trimmedBody);
    setName("");
    setBody("");
    setComposing(false);
  };

  const onFile = (e: ChangeEvent<HTMLInputElement>): void => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => onImport(String(reader.result ?? ""));
    reader.readAsText(file);
  };

  return (
    <div className="ctx-block">
      <div className="h">
        <span>{t("contextPanel.memoryTitle")}</span>
        <span className="right">
          <span className="mem-actions">
            <button
              type="button"
              className="mem-action"
              title={t("contextPanel.exportMemories")}
              onClick={onExport}
            >
              ⇪ {t("contextPanel.saveLabel")}
            </button>
            <button
              type="button"
              className="mem-action"
              title={t("contextPanel.importMemories")}
              onClick={() => fileRef.current?.click()}
            >
              ⇓ {t("contextPanel.loadLabel")}
            </button>
            <input
              ref={fileRef}
              type="file"
              accept=".json,application/json"
              style={{ display: "none" }}
              onChange={onFile}
            />
          </span>
        </span>
      </div>

      {result ? (
        <div className={`mem-result ${result.ok ? "" : "err"}`}>
          <span>{result.message}</span>
          <button type="button" className="mem-result-x" onClick={onDismissResult}>
            ✕
          </button>
        </div>
      ) : null}

      {entries.length === 0 ? (
        <div className="ctx-empty">{t("contextPanel.noMemoriesMsg")}</div>
      ) : (
        <div className="mem">
          {entries.map((m) => (
            <div
              className="mem-row"
              data-active={detail?.path === m.path}
              key={m.path}
              onClick={() => onRead(m.path)}
            >
              <span className="scope" data-s={m.scope}>
                {m.scope === "project" ? t("contextPanel.scopeProject") : t("contextPanel.scopeGlobal")}
              </span>
              <span className="txt">{m.description || m.name}</span>
              <button
                type="button"
                className="mem-del"
                title={t("contextPanel.deleteMemory")}
                onClick={(e) => {
                  e.stopPropagation();
                  onDelete(m.path);
                }}
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      )}

      {detail ? <pre className="mem-detail">{detail.body}</pre> : null}

      {composing ? (
        <div className="mem-composer">
          <div className="mem-composer-row">
            <input
              className="mem-input"
              placeholder={t("contextPanel.newNamePh")}
              value={name}
              onChange={(e) => setName(e.target.value)}
              spellCheck={false}
            />
            <select
              className="mem-scope"
              value={scope}
              onChange={(e) => setScope(e.target.value as "global" | "project")}
            >
              <option value="project">{t("contextPanel.scopeProject")}</option>
              <option value="global">{t("contextPanel.scopeGlobal")}</option>
            </select>
          </div>
          <textarea
            className="mem-textarea"
            placeholder={t("contextPanel.newBodyPh")}
            value={body}
            onChange={(e) => setBody(e.target.value)}
          />
          <div className="mem-composer-actions">
            <button type="button" className="btn small" disabled={!name.trim() || !body.trim()} onClick={submit}>
              {t("contextPanel.saveMemory")}
            </button>
            <button type="button" className="btn small ghost" onClick={() => setComposing(false)}>
              {t("contextPanel.cancelMemory")}
            </button>
          </div>
        </div>
      ) : (
        <button type="button" className="mem-new" onClick={() => setComposing(true)}>
          ＋ {t("contextPanel.newMemory")}
        </button>
      )}
    </div>
  );
}

function CtxRules({ settings }: { settings: Settings | null }) {
  const editMode = settings?.editMode ?? "review";
  const items: { p: string; allow: boolean; desc: string }[] =
    editMode === "yolo"
      ? [{ p: "*", allow: true, desc: t("contextPanel.ruleYolo") }]
      : editMode === "auto"
        ? [
            { p: "read_file, list_directory, search_files, *", allow: true, desc: t("contextPanel.ruleReadOnly") },
            { p: "run_command (allowlist)", allow: true, desc: t("contextPanel.ruleShellAllowlist") },
            { p: "edit_file, write_file, run_command (other)", allow: false, desc: t("contextPanel.ruleWritesAsk") },
          ]
        : [
            { p: "*", allow: false, desc: t("contextPanel.ruleReview") },
          ];
  return (
    <div className="ctx-block">
      <div className="h">
        <span>{t("contextPanel.autoApproveTitle")}</span>
        <span className="right">{editMode}</span>
      </div>
      {items.map((r) => (
        <div className="rule" key={r.p}>
          <div className="top">
            <span className={`pat ${r.allow ? "" : "deny"}`}>{r.p}</span>
            <span className={`sw ${r.allow ? "" : "deny"}`}>
              {r.allow ? t("contextPanel.allow") : t("contextPanel.ask")}
            </span>
          </div>
          <div className="desc">{r.desc}</div>
        </div>
      ))}
    </div>
  );
}
