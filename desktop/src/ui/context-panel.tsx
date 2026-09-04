import { invoke } from "@tauri-apps/api/core";
import { openPath } from "@tauri-apps/plugin-opener";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ChangeEvent } from "react";
import type { SessionFile, Settings, UsageStats } from "../App";
import { t, useLang } from "../i18n";
import type { TKey } from "../i18n";
import { I } from "../icons";
import type { McpSpecInfo, MemoryDetail, MemoryEntryInfo, SettingsPatch } from "../protocol";
import { PanelErrorBoundary } from "./error-boundary";
import { FileMenu } from "./file-menu";
import { activationHandler } from "./keyboard";

type Tab = "files" | "tools" | "memory" | "rules";

/** Fallback until the sidecar reports the real cap via $ctx_breakdown — the V4 context
 *  window is 300K (DEEPSEEK_CONTEXT_TOKENS); never show the old 1M API ceiling. */
const CONTEXT_MAX_TOKENS = 300_000;

/** 1_234_567 → "1.2M" or 500_000 → "500K" — used for compaction-limit labels and slider display. */
function fmtCompact(n: number): string {
  if (n >= 1_000_000) {
    const m = n / 1_000_000;
    return `${Number.isInteger(m) ? m : m.toFixed(1)}M`;
  }
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
  onCompact,
  onAddRule,
  onRemoveRule,
  onSaveSettings,
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
  onWriteMemory: (
    scope: "global" | "project",
    name: string,
    description: string,
    body: string,
  ) => void;
  onDeleteMemory: (path: string) => void;
  onExportMemories: () => void;
  onImportMemories: (json: string) => void;
  onDismissMemoryResult: () => void;
  onCompact?: () => void;
  onAddRule?: (ruleType: "shell" | "path", pattern: string) => void;
  onRemoveRule?: (ruleType: "shell" | "path", pattern: string) => void;
  onSaveSettings?: (patch: SettingsPatch) => void;
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
        <div
          className="ctx-tab"
          data-active={tab === "files"}
          onClick={() => setTab("files")}
          onKeyDown={activationHandler(() => setTab("files"))}
        >
          {t("contextPanel.filesTab")}
        </div>
        <div
          className="ctx-tab"
          data-active={tab === "tools"}
          onClick={() => setTab("tools")}
          onKeyDown={activationHandler(() => setTab("tools"))}
        >
          {t("contextPanel.toolsTab")}
        </div>
        <div
          className="ctx-tab"
          data-active={tab === "memory"}
          onClick={() => setTab("memory")}
          onKeyDown={activationHandler(() => setTab("memory"))}
        >
          {t("contextPanel.memoryTab")}
        </div>
        <div
          className="ctx-tab"
          data-active={tab === "rules"}
          onClick={() => setTab("rules")}
          onKeyDown={activationHandler(() => setTab("rules"))}
        >
          {t("contextPanel.rulesTab")}
        </div>
      </div>

      <div className="ctx-body">
        <div className="ctx-block">
          <div className="h">
            <span>{t("contextPanel.contextTokens")}</span>
            <span className="right" style={{ display: "flex", alignItems: "center", gap: 6 }}>
              {(reserved + used + cached).toLocaleString()} / {ctxMax.toLocaleString()}
              {onCompact ? (
                <button
                  type="button"
                  className="mini-btn"
                  title={t("contextPanel.compactBtnTooltip")}
                  onClick={onCompact}
                >
                  <I.archive size={11} />
                  <span style={{ marginLeft: 3, fontSize: 10.5 }}>
                    {t("contextPanel.compactBtn")}
                  </span>
                </button>
              ) : null}
            </span>
          </div>
          <div className="meter">
            <span className="rsvd" style={{ width: `${reservedPct}%` }} />
            <span className="cached" style={{ width: `${cachedPct}%` }} />
            <span className="used" style={{ width: `${usedPct}%` }} />
            {/* Auto-compaction limits (context-manager.ts): fold 75% / forced summary 80% */}
            <span
              className={`meter-tick fold ${settings?.disableAutoCompaction ? "disabled" : ""}`}
              style={{ left: "75%", opacity: settings?.disableAutoCompaction ? 0.3 : undefined }}
              title={
                settings?.disableAutoCompaction
                  ? t("contextPanel.autoCompactionDisabledTooltip")
                  : t("contextPanel.foldTick", {
                      tokens: fmtCompact(ctxMax * 0.75),
                    })
              }
            />
            <span
              className={`meter-tick force ${settings?.disableAutoCompaction ? "disabled" : ""}`}
              style={{ left: "80%", opacity: settings?.disableAutoCompaction ? 0.3 : undefined }}
              title={
                settings?.disableAutoCompaction
                  ? t("contextPanel.autoCompactionDisabledTooltip")
                  : t("contextPanel.forceTick", {
                      tokens: fmtCompact(ctxMax * 0.8),
                    })
              }
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
              {settings?.disableAutoCompaction
                ? t("contextPanel.compactionDisabled")
                : t("contextPanel.compactionAt", {
                    fold: fmtCompact(ctxMax * 0.75),
                    force: fmtCompact(ctxMax * 0.8),
                  })}
            </span>
          </div>
        </div>

        <PanelErrorBoundary key={tab} label={tab}>
          {tab === "files" && <CtxFiles files={sessionFiles} settings={settings} />}
          {tab === "tools" && (
            <CtxTools
              specs={mcpSpecs}
              bridged={mcpBridged}
              settings={settings}
              usage={usage}
              onSaveSettings={onSaveSettings}
            />
          )}
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
          {tab === "rules" && (
            <CtxRules settings={settings} onAddRule={onAddRule} onRemoveRule={onRemoveRule} />
          )}
        </PanelErrorBoundary>
      </div>
    </aside>
  );
}

type TreeNode =
  | { kind: "dir"; depth: number; name: string; key: string }
  | { kind: "file"; depth: number; name: string; path: string; key: string; status: "c" | "m" };

function resolveContextAbs(path: string, settings: Settings | null): string {
  const workspaceDir = settings?.workspaceDir;
  const isWindows = workspaceDir?.includes("\\") ?? false;
  const sep = isWindows ? "\\" : "/";
  return workspaceDir && !/^[a-zA-Z]:[\\/]/.test(path) && !path.startsWith("/")
    ? `${workspaceDir.replace(/[\\/]$/, "")}${sep}${path.replace(/^[\\/]+/, "").replace(/\//g, sep)}`
    : isWindows
      ? path.replace(/\//g, "\\")
      : path;
}

async function openContextFile(path: string, settings: Settings | null): Promise<void> {
  const abs = resolveContextAbs(path, settings);
  // Reveal the file in the OS file explorer (parent folder with the item
  // selected); openPath is only the last resort. The workspace lets the
  // Rust side resolve bare references to their real location.
  try {
    await invoke("reveal_in_explorer", {
      path: abs,
      workspace: settings?.workspaceDir ?? null,
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
  const [menu, setMenu] = useState<{ x: number; y: number; path: string } | null>(null);
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
                onKeyDown={activationHandler(() => void openContextFile(n.path, settings))}
                onContextMenu={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  setMenu({ x: e.clientX, y: e.clientY, path: n.path });
                }}
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
                  title={
                    n.status === "m"
                      ? t("contextPanel.fileModified")
                      : t("contextPanel.fileInContext")
                  }
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
      {menu ? (
        <FileMenu
          anchor={{ x: menu.x, y: menu.y }}
          abs={resolveContextAbs(menu.path, settings)}
          onClose={() => setMenu(null)}
        />
      ) : null}
    </div>
  );
}

type OllamaNumberKey = Exclude<
  keyof NonNullable<Settings["ollamaGeneration"]>,
  "keepAlive"
>;

const OLLAMA_NUMBER_FIELDS: Array<{
  key: OllamaNumberKey;
  labelKey: TKey;
  min: number;
  max: number;
  step: number;
  advanced?: boolean;
}> = [
  { key: "temperature", labelKey: "contextPanel.ollamaTemperature", min: 0, max: 2, step: 0.05 },
  { key: "topP", labelKey: "contextPanel.ollamaTopP", min: 0, max: 1, step: 0.01 },
  { key: "topK", labelKey: "contextPanel.ollamaTopK", min: 0, max: 1_000, step: 1 },
  { key: "minP", labelKey: "contextPanel.ollamaMinP", min: 0, max: 1, step: 0.01 },
  {
    key: "seed",
    labelKey: "contextPanel.ollamaSeed",
    min: 0,
    max: 2_147_483_647,
    step: 1,
    advanced: true,
  },
  {
    key: "repeatPenalty",
    labelKey: "contextPanel.ollamaRepeatPenalty",
    min: 0,
    max: 2,
    step: 0.05,
    advanced: true,
  },
  {
    key: "repeatLastN",
    labelKey: "contextPanel.ollamaRepeatLastN",
    min: -1,
    max: 1_000_000,
    step: 1,
    advanced: true,
  },
  {
    key: "frequencyPenalty",
    labelKey: "contextPanel.ollamaFrequencyPenalty",
    min: -2,
    max: 2,
    step: 0.05,
    advanced: true,
  },
  {
    key: "presencePenalty",
    labelKey: "contextPanel.ollamaPresencePenalty",
    min: -2,
    max: 2,
    step: 0.05,
    advanced: true,
  },
];

interface OllamaPreset {
  id: string;
  labelKey: TKey;
  tooltipKey: TKey;
  patch: NonNullable<SettingsPatch["ollamaGeneration"]>;
}

const OLLAMA_SAMPLING_PRESETS: OllamaPreset[] = [
  {
    id: "default",
    labelKey: "contextPanel.ollamaPresetDefault",
    tooltipKey: "contextPanel.ollamaPresetDefaultTooltip",
    patch: {
      temperature: null,
      topP: null,
      topK: null,
      minP: null,
      seed: null,
      repeatPenalty: null,
      repeatLastN: null,
      frequencyPenalty: null,
      presencePenalty: null,
    },
  },
  {
    id: "coding",
    labelKey: "contextPanel.ollamaPresetCoding",
    tooltipKey: "contextPanel.ollamaPresetCodingTooltip",
    patch: {
      temperature: 0.2,
      topP: 0.9,
      topK: 40,
      minP: null,
      seed: null,
      repeatPenalty: null,
      repeatLastN: null,
      frequencyPenalty: null,
      presencePenalty: null,
    },
  },
  {
    id: "balanced",
    labelKey: "contextPanel.ollamaPresetBalanced",
    tooltipKey: "contextPanel.ollamaPresetBalancedTooltip",
    patch: {
      temperature: 0.7,
      topP: 0.9,
      topK: 40,
      minP: 0.05,
      seed: null,
      repeatPenalty: null,
      repeatLastN: null,
      frequencyPenalty: null,
      presencePenalty: null,
    },
  },
  {
    id: "creative",
    labelKey: "contextPanel.ollamaPresetCreative",
    tooltipKey: "contextPanel.ollamaPresetCreativeTooltip",
    patch: {
      temperature: 1.0,
      topP: 0.95,
      topK: 50,
      minP: null,
      seed: null,
      repeatPenalty: null,
      repeatLastN: null,
      frequencyPenalty: null,
      presencePenalty: null,
    },
  },
  {
    id: "anti-loop",
    labelKey: "contextPanel.ollamaPresetAntiLoop",
    tooltipKey: "contextPanel.ollamaPresetAntiLoopTooltip",
    patch: {
      temperature: 0.7,
      topP: 0.9,
      topK: 40,
      minP: null,
      seed: null,
      repeatPenalty: 1.1,
      repeatLastN: 64,
      frequencyPenalty: null,
      presencePenalty: null,
    },
  },
];

function isPresetActive(
  preset: OllamaPreset,
  overrides: Settings["ollamaGenerationOverrides"],
): boolean {
  for (const field of OLLAMA_NUMBER_FIELDS) {
    const expected = preset.patch[field.key];
    const actual = overrides?.[field.key];
    if (expected === null) {
      if (actual !== undefined) return false;
    } else if (expected !== undefined) {
      if (actual !== expected) return false;
    }
  }
  return true;
}

function OllamaNumberField({
  field,
  value,
  overridden,
  onSaveSettings,
}: {
  field: (typeof OLLAMA_NUMBER_FIELDS)[number];
  value: number | undefined;
  overridden: boolean;
  onSaveSettings?: (patch: SettingsPatch) => void;
}) {
  const [draft, setDraft] = useState(value === undefined ? "" : String(value));
  useEffect(() => setDraft(value === undefined ? "" : String(value)), [value]);

  const commit = () => {
    if (!draft.trim()) return;
    const parsed = Number(draft);
    if (!Number.isFinite(parsed) || parsed < field.min || parsed > field.max) {
      setDraft(value === undefined ? "" : String(value));
      return;
    }
    onSaveSettings?.({ ollamaGeneration: { [field.key]: parsed } });
  };

  return (
    <label className="ollama-field">
      <span>{t(field.labelKey)}</span>
      <span className="ollama-field-control">
        <input
          type="number"
          value={draft}
          min={field.min}
          max={field.max}
          step={field.step}
          placeholder={t("contextPanel.ollamaModelDefault")}
          aria-label={t(field.labelKey)}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === "Enter") event.currentTarget.blur();
          }}
        />
        {overridden ? (
          <button
            type="button"
            className="mini-btn"
            title={t("contextPanel.ollamaResetTooltip")}
            onClick={() => onSaveSettings?.({ ollamaGeneration: { [field.key]: null } })}
          >
            {t("contextPanel.contextWindowReset")}
          </button>
        ) : null}
      </span>
    </label>
  );
}

function OllamaGenerationControls({
  settings,
  onSaveSettings,
}: {
  settings: Settings;
  onSaveSettings?: (patch: SettingsPatch) => void;
}) {
  const values = settings.ollamaGeneration;
  const overrides = settings.ollamaGenerationOverrides;
  const [keepAlive, setKeepAlive] = useState(values?.keepAlive ?? "30m");
  useEffect(() => setKeepAlive(values?.keepAlive ?? "30m"), [values?.keepAlive]);

  const fields = (advanced: boolean) =>
    OLLAMA_NUMBER_FIELDS.filter((field) => Boolean(field.advanced) === advanced).map((field) => (
      <OllamaNumberField
        key={field.key}
        field={field}
        value={values?.[field.key]}
        overridden={overrides?.[field.key] !== undefined}
        onSaveSettings={onSaveSettings}
      />
    ));

  return (
    <div className="ctx-block ollama-generation" data-testid="ollama-generation-settings">
      <div className="h">
        <span>{t("contextPanel.ollamaGeneration")}</span>
        <span className="right">{t("contextPanel.ollamaNativeApi")}</span>
      </div>
      <p className="ollama-help">{t("contextPanel.ollamaGenerationHelp")}</p>
      <div className="ollama-presets" role="group" aria-label={t("contextPanel.ollamaGeneration")}>
        {OLLAMA_SAMPLING_PRESETS.map((preset) => {
          const active = isPresetActive(preset, overrides);
          return (
            <button
              key={preset.id}
              type="button"
              className="ollama-preset-btn"
              data-active={active ? "true" : undefined}
              title={t(preset.tooltipKey)}
              onClick={() => onSaveSettings?.({ ollamaGeneration: preset.patch })}
            >
              {t(preset.labelKey)}
            </button>
          );
        })}
      </div>
      <div className="ollama-fields">{fields(false)}</div>
      <details className="ollama-advanced">
        <summary>{t("contextPanel.ollamaAdvanced")}</summary>
        <div className="ollama-fields">
          {fields(true)}
          <label className="ollama-field">
            <span>{t("contextPanel.ollamaKeepAlive")}</span>
            <span className="ollama-field-control">
              <input
                value={keepAlive}
                aria-label={t("contextPanel.ollamaKeepAlive")}
                list="ollama-keep-alive-options"
                onChange={(event) => setKeepAlive(event.target.value)}
                onBlur={() => {
                  const value = keepAlive.trim();
                  if (value) onSaveSettings?.({ ollamaGeneration: { keepAlive: value } });
                  else setKeepAlive(values?.keepAlive ?? "30m");
                }}
              />
              {overrides?.keepAlive !== undefined ? (
                <button
                  type="button"
                  className="mini-btn"
                  title={t("contextPanel.ollamaResetTooltip")}
                  onClick={() => onSaveSettings?.({ ollamaGeneration: { keepAlive: null } })}
                >
                  {t("contextPanel.contextWindowReset")}
                </button>
              ) : null}
            </span>
          </label>
          <datalist id="ollama-keep-alive-options">
            <option value="0" />
            <option value="5m" />
            <option value="30m" />
            <option value="1h" />
            <option value="-1" />
          </datalist>
        </div>
      </details>
    </div>
  );
}

function CtxTools({
  specs,
  bridged,
  settings,
  usage,
  onSaveSettings,
}: {
  specs: McpSpecInfo[];
  bridged: boolean;
  settings: Settings | null;
  usage: UsageStats;
  onSaveSettings?: (patch: SettingsPatch) => void;
}) {
  const readyCount = specs.filter((s) => s.status === "connected").length;
  const effectiveTokens = settings?.contextTokens ?? usage.ctxMax ?? 300_000;
  const clampedTokens = Math.min(1_000_000, Math.max(128_000, effectiveTokens));
  const [sliderValue, setSliderValue] = useState<number>(clampedTokens);

  useEffect(() => {
    setSliderValue(clampedTokens);
  }, [clampedTokens]);

  const commit = (val: number) => {
    const next = Math.min(1_000_000, Math.max(128_000, val));
    onSaveSettings?.({ contextTokens: next });
  };

  const effectiveMaxIter = settings?.maxIterPerTurn ?? 50;
  const clampedMaxIter = Math.min(100, Math.max(50, effectiveMaxIter));
  const [iterValue, setIterValue] = useState<number>(clampedMaxIter);

  useEffect(() => {
    setIterValue(clampedMaxIter);
  }, [clampedMaxIter]);

  const commitIter = (val: number) => {
    const next = Math.min(100, Math.max(50, val));
    onSaveSettings?.({ maxIterPerTurn: next });
  };

  return (
    <>
      <div className="ctx-block">
        <div className="h">
          <span>{t("contextPanel.contextWindow")}</span>
          <span className="right" style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span>
              {fmtCompact(sliderValue)} ({sliderValue.toLocaleString()})
            </span>
            {settings?.contextTokens !== undefined && settings?.contextTokens !== null ? (
              <button
                type="button"
                className="mini-btn"
                title={t("contextPanel.contextWindowResetTooltip")}
                onClick={() => onSaveSettings?.({ contextTokens: null })}
              >
                {t("contextPanel.contextWindowReset")}
              </button>
            ) : null}
          </span>
        </div>
        <div className="ctx-slider-container">
          <input
            type="range"
            className="ctx-slider"
            min={128_000}
            max={1_000_000}
            step={1_000}
            value={sliderValue}
            aria-label={t("contextPanel.contextWindow")}
            onChange={(e) => setSliderValue(Number(e.target.value))}
            onPointerUp={(e) => commit(Number(e.currentTarget.value))}
            onKeyUp={(e) => commit(Number(e.currentTarget.value))}
          />
          <div className="ctx-slider-bounds">
            <span>128K</span>
            <span>1M</span>
          </div>
        </div>
      </div>

      <div className="ctx-block">
        <div className="h">
          <span>{t("contextPanel.maxIterations")}</span>
          <span className="right" style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span>{t("contextPanel.maxIterationsUnit", { count: iterValue })}</span>
            {settings?.maxIterPerTurnOverride !== undefined &&
            settings?.maxIterPerTurnOverride !== null ? (
              <button
                type="button"
                className="mini-btn"
                title={t("contextPanel.maxIterationsResetTooltip")}
                onClick={() => onSaveSettings?.({ maxIterPerTurn: null })}
              >
                {t("contextPanel.contextWindowReset")}
              </button>
            ) : null}
          </span>
        </div>
        <div className="ctx-slider-container">
          <input
            type="range"
            className="ctx-slider"
            min={50}
            max={100}
            step={1}
            value={iterValue}
            aria-label={t("contextPanel.maxIterations")}
            onChange={(e) => setIterValue(Number(e.target.value))}
            onPointerUp={(e) => commitIter(Number(e.currentTarget.value))}
            onKeyUp={(e) => commitIter(Number(e.currentTarget.value))}
          />
          <div className="ctx-slider-bounds">
            <span>50</span>
            <span>100</span>
          </div>
        </div>
      </div>

      <div className="ctx-block">
        <div className="h">
          <span>{t("contextPanel.autoCompaction")}</span>
          <span className="right">
            <div className="seg-ctrl" style={{ fontSize: "10.5px" }}>
              <button
                type="button"
                data-on={!settings?.disableAutoCompaction}
                onClick={() => onSaveSettings?.({ disableAutoCompaction: false })}
              >
                {t("contextPanel.autoCompactionEnabled")}
              </button>
              <button
                type="button"
                data-on={!!settings?.disableAutoCompaction}
                onClick={() => onSaveSettings?.({ disableAutoCompaction: true })}
              >
                {t("contextPanel.autoCompactionDisabled")}
              </button>
            </div>
          </span>
        </div>
        <div style={{ fontSize: "11px", color: "var(--muted)", marginTop: 6, lineHeight: 1.4 }}>
          {settings?.disableAutoCompaction
            ? t("contextPanel.autoCompactionDisabledDesc")
            : t("contextPanel.autoCompactionEnabledDesc")}
        </div>
      </div>

      {settings &&
      (settings.modelEndpoint?.provider === "ollama" ||
        settings.subagentModelEndpoint?.provider === "ollama") ? (
        <OllamaGenerationControls settings={settings} onSaveSettings={onSaveSettings} />
      ) : null}

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
    </>
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
              onKeyDown={activationHandler(() => onRead(m.path))}
            >
              <span className="scope" data-s={m.scope}>
                {m.scope === "project"
                  ? t("contextPanel.scopeProject")
                  : t("contextPanel.scopeGlobal")}
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
            <button
              type="button"
              className="btn small"
              disabled={!name.trim() || !body.trim()}
              onClick={submit}
            >
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

function CtxRules({
  settings,
  onAddRule,
  onRemoveRule,
}: {
  settings: Settings | null;
  onAddRule?: (ruleType: "shell" | "path", pattern: string) => void;
  onRemoveRule?: (ruleType: "shell" | "path", pattern: string) => void;
}) {
  const [ruleType, setRuleType] = useState<"shell" | "path">("shell");
  const [pattern, setPattern] = useState("");

  const editMode = settings?.editMode ?? "review";
  const items: { p: string; allow: boolean; desc: string }[] =
    editMode === "yolo"
      ? [{ p: "*", allow: true, desc: t("contextPanel.ruleYolo") }]
      : editMode === "auto"
        ? [
            {
              p: "read_file, list_directory, search_files, *",
              allow: true,
              desc: t("contextPanel.ruleReadOnly"),
            },
            {
              p: "run_command (allowlist)",
              allow: true,
              desc: t("contextPanel.ruleShellAllowlist"),
            },
            {
              p: "edit_file, write_file, run_command (other)",
              allow: false,
              desc: t("contextPanel.ruleWritesAsk"),
            },
          ]
        : [{ p: "*", allow: false, desc: t("contextPanel.ruleReview") }];

  const shellRules = settings?.shellAllowed ?? [];
  const pathRules = settings?.pathAllowed ?? [];
  const totalCustom = shellRules.length + pathRules.length;

  const handleAdd = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = pattern.trim();
    if (!trimmed || !onAddRule) return;
    onAddRule(ruleType, trimmed);
    setPattern("");
  };

  return (
    <>
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

      <div className="ctx-block" style={{ marginTop: 14 }}>
        <div className="h">
          <span>{t("contextPanel.customRulesTitle")}</span>
          <span className="right">{totalCustom}</span>
        </div>

        {shellRules.map((r) => (
          <div className="rule" key={`shell-${r}`}>
            <div className="top">
              <span className="pat">{r}</span>
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <span className="sw">{t("contextPanel.allow")}</span>
                {onRemoveRule && (
                  <button
                    type="button"
                    className="mini-btn"
                    title={t("contextPanel.deleteRuleTooltip")}
                    aria-label={`Remove rule: ${r}`}
                    onClick={() => onRemoveRule("shell", r)}
                  >
                    <I.trash size={12} />
                  </button>
                )}
              </div>
            </div>
            <div className="desc">{t("contextPanel.ruleTypeShell")}</div>
          </div>
        ))}

        {pathRules.map((r) => (
          <div className="rule" key={`path-${r}`}>
            <div className="top">
              <span className="pat">{r}</span>
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <span className="sw">{t("contextPanel.allow")}</span>
                {onRemoveRule && (
                  <button
                    type="button"
                    className="mini-btn"
                    title={t("contextPanel.deleteRuleTooltip")}
                    aria-label={`Remove rule: ${r}`}
                    onClick={() => onRemoveRule("path", r)}
                  >
                    <I.trash size={12} />
                  </button>
                )}
              </div>
            </div>
            <div className="desc">{t("contextPanel.ruleTypePath")}</div>
          </div>
        ))}

        {totalCustom === 0 && (
          <div style={{ color: "var(--muted)", fontSize: 12, padding: "4px 0" }}>
            {t("contextPanel.noCustomRules")}
          </div>
        )}

        {onAddRule && (
          <form className="rule-composer" onSubmit={handleAdd}>
            <div className="rule-composer-row">
              <select
                className="rule-select"
                value={ruleType}
                onChange={(e) => setRuleType(e.target.value as "shell" | "path")}
                aria-label="Rule type"
              >
                <option value="shell">{t("contextPanel.ruleTypeShell")}</option>
                <option value="path">{t("contextPanel.ruleTypePath")}</option>
              </select>
              <input
                type="text"
                className="rule-input"
                placeholder={t("contextPanel.rulePatternPlaceholder")}
                value={pattern}
                onChange={(e) => setPattern(e.target.value)}
                aria-label="Rule pattern"
              />
              <button
                type="submit"
                className="btn small"
                disabled={!pattern.trim()}
                title={t("contextPanel.addRuleBtn")}
                aria-label={t("contextPanel.addRuleBtn")}
              >
                <I.plus size={12} />
              </button>
            </div>
          </form>
        )}
      </div>
    </>
  );
}
