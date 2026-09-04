import {
  ANTIGRAVITY_MODELS,
  GPT56_MODELS,
  SUPPORTED_OFFICIAL_MODELS,
  ZAI_MODELS,
  isUsableAntigravityModel,
  modelAcceptsImages,
  modelDisplayName,
} from "@reasonix/core-utils";
import { openUrl } from "@tauri-apps/plugin-opener";
import { type ChangeEvent, type ReactNode, useEffect, useRef, useState } from "react";
import type { Balance, Settings as SettingsType, UsageStats } from "../App";
import { t } from "../i18n";
import { I } from "../icons";
import type {
  McpSpecInfo,
  MemoryDetail,
  MemoryEntryInfo,
  SettingsPatch,
} from "../protocol";
import {
  FONT_FAMILY,
  FONT_SCALE,
  type FontFamily,
  type FontScale,
  THEME,
  THEME_STYLES,
  type Theme,
  type ThemeStyle,
  themeForStyle,
} from "../theme";
import { activationHandler, escapeHandler } from "./keyboard";
import { Shortcut, type ShortcutKey } from "./shortcut";

/** Render i18n hint strings that embed `<code>…</code>` tags as styled fragments
 *  (no dangerouslySetInnerHTML — the markup is translator-authored, but React nodes keep it static). */
function hintNodes(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /<code>([^<]+)<\/code>/g;
  let last = 0;
  let n = 0;
  for (const m of text.matchAll(re)) {
    if (m.index! > last) out.push(text.slice(last, m.index!));
    out.push(<code key={n}>{m[1]}</code>);
    n += 1;
    last = m.index! + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export type PageId =
  | "general"
  | "models"
  | "mcp"
  | "memory"
  | "rules"
  | "billing"
  | "shortcuts";

const PAGE_META: ReadonlyArray<{ id: PageId; icon: keyof typeof I }> = [
  { id: "general", icon: "cog" },
  { id: "models", icon: "brain" },
  { id: "mcp", icon: "wrench" },
  { id: "memory", icon: "bookmark" },
  { id: "rules", icon: "shield" },
  { id: "billing", icon: "coin" },
  { id: "shortcuts", icon: "cpu" },
];

export function SettingsModal({
  settings,
  balance,
  usage,
  currency,
  theme,
  themeStyle,
  onSetTheme,
  onSetThemeStyle,
  fontScale,
  onSetFontScale,
  fontFamily,
  onSetFontFamily,
  customFontFamily,
  onSetCustomFontFamily,
  initialPage,
  mcpSpecs,
  mcpBridged,
  memory,
  memoryDetail,
  memoryResult,
  onClose,
  onSave,
  onSaveApiKey,
  oauthWaiting,
  onOAuthBegin,
  onOAuthCancel,
  onOAuthSignOut,
  onSaveOpenAIApiKey,
  antigravityOAuthWaiting,
  onAntigravityOAuthBegin,
  onAntigravityOAuthCancel,
  onAntigravityOAuthSignOut,
  ollamaBaseUrl,
  ollamaModels,
  ollamaModelsError,
  ollamaPlan,
  ollamaHiddenCount,
  ollamaVisionModels,
  onRefreshOllamaModels,
  onPickWorkspace,
  onAddMcpSpec,
  onRemoveMcpSpec,
  onReadMemory,
  onWriteMemory,
  onDeleteMemory,
  onExportMemories,
  onImportMemories,
  onDismissMemoryResult,
  onAddRule,
  onRemoveRule,
}: {
  settings: SettingsType;
  balance: Balance | null;
  usage: UsageStats;
  currency: "CNY" | "USD";
  theme: Theme;
  themeStyle: ThemeStyle;
  onSetTheme: (theme: Theme) => void;
  onSetThemeStyle: (style: ThemeStyle) => void;
  fontScale: FontScale;
  onSetFontScale: (scale: FontScale) => void;
  fontFamily: FontFamily;
  onSetFontFamily: (family: FontFamily) => void;
  customFontFamily: string;
  onSetCustomFontFamily: (family: string) => void;
  initialPage?: PageId;
  mcpSpecs: McpSpecInfo[];
  mcpBridged: boolean;
  memory: MemoryEntryInfo[];
  memoryDetail: MemoryDetail | null;
  memoryResult: { ok: boolean; message: string } | null;
  onAddRule?: (ruleType: "shell" | "path", pattern: string) => void;
  onRemoveRule?: (ruleType: "shell" | "path", pattern: string) => void;
  onClose: () => void;
  onSave: (patch: SettingsPatch) => void;
  onSaveApiKey: (key: string) => void;
  /** Ollama chat endpoint (OpenAI-compatible) shown on the Models page. */
  ollamaBaseUrl?: string;
  /** Dynamically fetched Ollama models (raw ids) — rendered as a scrollable grid. */
  ollamaModels?: string[];
  /** Why the last fetch failed — replaces the grid so the failure isn't silent. */
  ollamaModelsError?: string;
  /** The account's Ollama plan (e.g. `free`) when the cloud reported it. */
  ollamaPlan?: string;
  /** Models hidden because the account's plan doesn't cover them. */
  ollamaHiddenCount?: number;
  /** Re-fetch the Ollama model catalog (`force` bypasses the backend's cache). */
  onRefreshOllamaModels?: (force?: boolean) => void;
  /** Prefixed vision-capable Ollama ids (`ollama/llava`) — shown as a badge. */
  ollamaVisionModels?: ReadonlySet<string>;
  oauthWaiting: boolean;
  onOAuthBegin: () => void;
  onOAuthCancel: () => void;
  onOAuthSignOut: () => void;
  onSaveOpenAIApiKey: (key: string) => void;
  antigravityOAuthWaiting: boolean;
  onAntigravityOAuthBegin: () => void;
  onAntigravityOAuthCancel: () => void;
  onAntigravityOAuthSignOut: () => void;
  onPickWorkspace: () => void;
  onAddMcpSpec: (spec: string) => void;
  onRemoveMcpSpec: (spec: string) => void;
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
}) {
  const [page, setPage] = useState<PageId>(initialPage ?? "general");
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  const currentMeta = PAGE_META.find((p) => p.id === page) ?? PAGE_META[0]!;
  return (
    <div
      className="settings-mask"
      onClick={onClose}
      onKeyDown={escapeHandler(onClose)}
      tabIndex={-1}
    >
      <div
        className="settings"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
      >
        <nav className="settings-side">
          <div className="sg">{t("settings.title")}</div>
          {PAGE_META.map((p) => (
            <div
              key={p.id}
              className="row"
              data-active={page === p.id}
              onClick={() => setPage(p.id)}
              onKeyDown={activationHandler(() => setPage(p.id))}
            >
              <span className="ico">{I[p.icon]({ size: 13 })}</span>
              <span>{t(`settings.page${p.id[0]!.toUpperCase()}${p.id.slice(1)}Label` as any)}</span>
            </div>
          ))}
        </nav>
        <div className="settings-main">
          <div className="settings-head">
            <div>
              <h2>
                {t(
                  `settings.page${currentMeta.id[0]!.toUpperCase()}${currentMeta.id.slice(1)}Label` as any,
                )}
              </h2>
              <div className="desc">
                {t(
                  `settings.page${currentMeta.id[0]!.toUpperCase()}${currentMeta.id.slice(1)}Desc` as any,
                )}
              </div>
            </div>
            <span className="grow" />
            <button type="button" className="close-btn" onClick={onClose}>
              <I.x size={14} />
            </button>
          </div>
          <div className="settings-body">
            {page === "general" && (
              <PageGeneral
                settings={settings}
                theme={theme}
                themeStyle={themeStyle}
                onSetTheme={onSetTheme}
                onSetThemeStyle={onSetThemeStyle}
                fontScale={fontScale}
                onSetFontScale={onSetFontScale}
                fontFamily={fontFamily}
                onSetFontFamily={onSetFontFamily}
                customFontFamily={customFontFamily}
                onSetCustomFontFamily={onSetCustomFontFamily}
                onSave={onSave}
                onPickWorkspace={onPickWorkspace}
              />
            )}
            {page === "models" && (
              <PageModels
                settings={settings}
                onSave={onSave}
                baseUrl={settings.baseUrl}
                apiKeyPrefix={settings.apiKeyPrefix}
                onSaveApiKey={onSaveApiKey}
                ollamaBaseUrl={ollamaBaseUrl}
                ollamaModels={ollamaModels}
                ollamaModelsError={ollamaModelsError}
                ollamaPlan={ollamaPlan}
                ollamaHiddenCount={ollamaHiddenCount}
                ollamaVisionModels={ollamaVisionModels}
                onRefreshOllamaModels={onRefreshOllamaModels}
                oauthSignedIn={settings.openaiOAuth?.signedIn ?? false}
                oauthAccount={settings.openaiOAuth?.account}
                oauthFlowError={settings.openaiOAuth?.flowError}
                oauthWaiting={oauthWaiting}
                onOAuthBegin={onOAuthBegin}
                onOAuthCancel={onOAuthCancel}
                onOAuthSignOut={onOAuthSignOut}
                onSaveOpenAIApiKey={onSaveOpenAIApiKey}
                antigravitySignedIn={settings.antigravityOAuth?.signedIn ?? false}
                antigravityAccount={settings.antigravityOAuth?.account}
                antigravityFlowError={settings.antigravityOAuth?.flowError}
                antigravityWaiting={antigravityOAuthWaiting}
                onAntigravityBegin={onAntigravityOAuthBegin}
                onAntigravityCancel={onAntigravityOAuthCancel}
                onAntigravitySignOut={onAntigravityOAuthSignOut}
              />
            )}
            {page === "mcp" && (
              <PageMCP
                specs={mcpSpecs}
                bridged={mcpBridged}
                onAdd={onAddMcpSpec}
                onRemove={onRemoveMcpSpec}
              />
            )}
            {page === "memory" && (
              <PageMemory
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
            {page === "rules" && (
              <PageRules
                settings={settings}
                onSave={onSave}
                onAddRule={onAddRule}
                onRemoveRule={onRemoveRule}
              />
            )}
            {page === "billing" && (
              <PageBilling balance={balance} usage={usage} currency={currency} />
            )}
            {page === "shortcuts" && <PageShortcuts />}
          </div>
        </div>
      </div>
    </div>
  );
}

function PageGeneral({
  settings,
  theme,
  themeStyle,
  onSetTheme,
  onSetThemeStyle,
  fontScale,
  onSetFontScale,
  fontFamily,
  onSetFontFamily,
  customFontFamily,
  onSetCustomFontFamily,
  onSave,
  onPickWorkspace,
}: {
  settings: SettingsType;
  theme: Theme;
  themeStyle: ThemeStyle;
  onSetTheme: (theme: Theme) => void;
  onSetThemeStyle: (style: ThemeStyle) => void;
  fontScale: FontScale;
  onSetFontScale: (scale: FontScale) => void;
  fontFamily: FontFamily;
  onSetFontFamily: (family: FontFamily) => void;
  customFontFamily: string;
  onSetCustomFontFamily: (family: string) => void;
  onSave: (patch: SettingsPatch) => void;
  onPickWorkspace: () => void;
}) {
  const [customFontDraft, setCustomFontDraft] = useState(customFontFamily);
  useEffect(() => {
    setCustomFontDraft(customFontFamily);
  }, [customFontFamily]);
  const commitCustomFont = (value: string) => {
    const next = value.trim();
    setCustomFontDraft(next);
    onSetCustomFontFamily(next);
  };
  return (
    <>
      <section className="section">
        <div className="stitle">{t("settings.appearanceSection")}</div>
        <div className="setting-row">
          <div className="l">
            <div className="n">{t("settings.theme")}</div>
            <div className="h">{t("settings.themeHint")}</div>
          </div>
          <div className="seg-ctrl">
            <button
              type="button"
              data-on={theme === THEME.DARK}
              onClick={() => onSetTheme(THEME.DARK)}
            >
              {t("settings.themeDark")}
            </button>
            <button
              type="button"
              data-on={theme === THEME.LIGHT}
              onClick={() => onSetTheme(THEME.LIGHT)}
            >
              {t("settings.themeLight")}
            </button>
          </div>
        </div>
        <div className="setting-row theme-style-row">
          <div className="l">
            <div className="n">{t("settings.themeStyle")}</div>
            <div className="h">{t("settings.themeStyleHint")}</div>
          </div>
          <div className="style-grid">
            {THEME_STYLES.map((style) => (
              <button
                key={style}
                type="button"
                className="style-card"
                data-on={themeStyle === style}
                data-style={style}
                onClick={() => onSetThemeStyle(style)}
              >
                <span className="style-card-head">
                  <span className="style-name">
                    {t(`settings.themeStyle${style[0]!.toUpperCase()}${style.slice(1)}` as any)}
                  </span>
                  <span className="style-mode">
                    {themeForStyle(style) === THEME.DARK
                      ? t("settings.themeDark")
                      : t("settings.themeLight")}
                  </span>
                </span>
                <span className="style-swatches" aria-hidden="true">
                  <span />
                  <span />
                  <span />
                </span>
                <span className="style-desc">
                  {t(`settings.themeStyle${style[0]!.toUpperCase()}${style.slice(1)}Desc` as any)}
                </span>
              </button>
            ))}
          </div>
        </div>
        <div className="setting-row">
          <div className="l">
            <div className="n">{t("settings.fontScale")}</div>
            <div className="h">{t("settings.fontScaleHint")}</div>
          </div>
          <div className="seg-ctrl">
            <button
              type="button"
              data-on={fontScale === FONT_SCALE.SMALL}
              onClick={() => onSetFontScale(FONT_SCALE.SMALL)}
            >
              {t("settings.fontScaleSmall")}
            </button>
            <button
              type="button"
              data-on={fontScale === FONT_SCALE.MEDIUM}
              onClick={() => onSetFontScale(FONT_SCALE.MEDIUM)}
            >
              {t("settings.fontScaleMedium")}
            </button>
            <button
              type="button"
              data-on={fontScale === FONT_SCALE.LARGE}
              onClick={() => onSetFontScale(FONT_SCALE.LARGE)}
            >
              {t("settings.fontScaleLarge")}
            </button>
          </div>
        </div>
        <div className="setting-row">
          <div className="l">
            <div className="n">{t("settings.fontFamily")}</div>
            <div className="h">{t("settings.fontFamilyHint")}</div>
          </div>
          <div className="seg-ctrl">
            <button
              type="button"
              data-on={fontFamily === FONT_FAMILY.SANS}
              onClick={() => onSetFontFamily(FONT_FAMILY.SANS)}
            >
              {t("settings.fontFamilySans")}
            </button>
            <button
              type="button"
              data-on={fontFamily === FONT_FAMILY.SYSTEM}
              onClick={() => onSetFontFamily(FONT_FAMILY.SYSTEM)}
            >
              {t("settings.fontFamilySystem")}
            </button>
            <button
              type="button"
              data-on={fontFamily === FONT_FAMILY.SERIF}
              onClick={() => onSetFontFamily(FONT_FAMILY.SERIF)}
            >
              {t("settings.fontFamilySerif")}
            </button>
            <button
              type="button"
              data-on={fontFamily === FONT_FAMILY.CUSTOM}
              onClick={() => onSetFontFamily(FONT_FAMILY.CUSTOM)}
            >
              {t("settings.fontFamilyCustom")}
            </button>
          </div>
        </div>
        {fontFamily === FONT_FAMILY.CUSTOM && (
          <div className="setting-row">
            <div className="l">
              <div className="n">{t("settings.customFontFamily")}</div>
              <div className="h">{t("settings.customFontFamilyHint")}</div>
            </div>
            <input
              className="field font-family-field"
              value={customFontDraft}
              placeholder={`"Microsoft YaHei", "PingFang SC", sans-serif`}
              onChange={(e) => {
                setCustomFontDraft(e.target.value);
                onSetCustomFontFamily(e.target.value);
              }}
              onBlur={(e) => commitCustomFont(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.currentTarget.blur();
                }
              }}
            />
          </div>
        )}
      </section>

      <section className="section">
        <div className="stitle">{t("settings.workspaceSection")}</div>
        <div className="setting-row">
          <div className="l">
            <div className="n">{t("settings.currentWorkspace")}</div>
            <div className="h">{settings.workspaceDir || t("settings.notSelected")}</div>
          </div>
          <button type="button" className="btn" onClick={onPickWorkspace}>
            {t("settings.workspaceChange")}
          </button>
        </div>
      </section>

      <section className="section">
        <div className="stitle">{t("settings.behaviorSection")}</div>
        <div className="setting-row">
          <div className="l">
            <div className="n">{t("settings.showSystemEvents")}</div>
            <div className="h">{t("settings.showSystemEventsHint")}</div>
          </div>
          <div className="seg-ctrl">
            <button
              type="button"
              data-on={settings.showSystemEvents !== false}
              onClick={() => onSave({ showSystemEvents: true })}
            >
              {t("settings.shown")}
            </button>
            <button
              type="button"
              data-on={settings.showSystemEvents === false}
              onClick={() => onSave({ showSystemEvents: false })}
            >
              {t("settings.hidden")}
            </button>
          </div>
        </div>
        <div className="setting-row">
          <div className="l">
            <div className="n">{t("settings.budget")}</div>
            <div className="h">{t("settings.budgetHint")}</div>
          </div>
          <input
            className="field"
            type="number"
            defaultValue={settings.budgetUsd ?? ""}
            placeholder={t("settings.budgetPlaceholder")}
            onBlur={(e) => {
              const v = e.target.value.trim();
              onSave({ budgetUsd: v === "" ? null : Number(v) });
            }}
          />
        </div>
        <div className="setting-row">
          <div className="l">
            <div className="n">{t("settings.contextWindow")}</div>
            <div className="h">{t("settings.contextWindowHint")}</div>
          </div>
          <input
            key={`ctx-${settings.contextTokens ?? "default"}`}
            className="field"
            type="number"
            min={300000}
            max={1000000}
            step={50000}
            defaultValue={settings.contextTokens ?? ""}
            placeholder={t("settings.contextWindowPlaceholder")}
            onBlur={(e) => {
              const v = e.target.value.trim();
              if (v === "") {
                onSave({ contextTokens: null });
                return;
              }
              const n = Number(v);
              // Guard NaN (partial entries like "1e") and clamp here so the
              // daemon never sees an out-of-range or invalid value.
              if (Number.isFinite(n)) {
                onSave({ contextTokens: Math.min(1000000, Math.max(300000, Math.floor(n))) });
              }
            }}
          />
        </div>
        <div className="setting-row">
          <div className="l">
            <div className="n">{t("settings.webSearchEngine")}</div>
            <div className="h">{t("settings.webSearchEngineNote")}</div>
          </div>
          <select
            className="field"
            value={settings.webSearchEngine ?? "bing"}
            onChange={(e) =>
              onSave({
                webSearchEngine: e.target.value as
                  | "bing"
                  | "bing-intl"
                  | "searxng"
                  | "metaso"
                  | "baidu"
                  | "tavily"
                  | "perplexity"
                  | "exa"
                  | "brave"
                  | "ollama"
                  | "zai",
              })
            }
          >
            <option value="bing">{t("settings.webSearchEngineBing")}</option>
            <option value="bing-intl">{t("settings.webSearchEngineBingIntl")}</option>
            <option value="searxng">{t("settings.webSearchEngineSearxng")}</option>
            <option value="metaso">{t("settings.webSearchEngineMetaso")}</option>
            <option value="baidu">{t("settings.webSearchEngineBaidu")}</option>
            <option value="tavily">{t("settings.webSearchEngineTavily")}</option>
            <option value="perplexity">{t("settings.webSearchEnginePerplexity")}</option>
            <option value="exa">{t("settings.webSearchEngineExa")}</option>
            <option value="brave">{t("settings.webSearchEngineBrave")}</option>
            <option value="ollama">{t("settings.webSearchEngineOllama")}</option>
            <option value="zai">{t("settings.webSearchEngineZai")}</option>
          </select>
        </div>
        <WebSearchEngineCredentials settings={settings} onSave={onSave} />
      </section>
    </>
  );
}

const SEARCH_ENGINE_API_KEY_FIELDS: ReadonlyArray<{
  engine:
    | "metaso"
    | "baidu"
    | "tavily"
    | "perplexity"
    | "exa"
    | "brave"
    | "ollama"
    | "zai";
  patchKey:
    | "metasoApiKey"
    | "baiduApiKey"
    | "tavilyApiKey"
    | "perplexityApiKey"
    | "exaApiKey"
    | "braveApiKey"
    | "ollamaApiKey"
    | "zaiApiKey";
  signupUrl: string;
}> = [
  { engine: "metaso", patchKey: "metasoApiKey", signupUrl: "https://metaso.cn/settings/api" },
  {
    engine: "baidu",
    patchKey: "baiduApiKey",
    signupUrl: "https://console.bce.baidu.com/qianfan/ais/console/onlineService",
  },
  { engine: "tavily", patchKey: "tavilyApiKey", signupUrl: "https://app.tavily.com" },
  {
    engine: "perplexity",
    patchKey: "perplexityApiKey",
    signupUrl: "https://www.perplexity.ai/settings/api",
  },
  { engine: "exa", patchKey: "exaApiKey", signupUrl: "https://dashboard.exa.ai/api-keys" },
  { engine: "brave", patchKey: "braveApiKey", signupUrl: "https://brave.com/search/api/" },
  { engine: "ollama", patchKey: "ollamaApiKey", signupUrl: "https://ollama.com/settings/keys" },
  { engine: "zai", patchKey: "zaiApiKey", signupUrl: "https://z.ai/manage-apikey/apikey-list" },
];

function WebSearchEngineCredentials({
  settings,
  onSave,
}: {
  settings: SettingsType;
  onSave: (patch: SettingsPatch) => void;
}) {
  const engine = settings.webSearchEngine ?? "bing";
  if (engine === "bing") return null;
  if (engine === "searxng") {
    return <SearxngEndpointRow settings={settings} onSave={onSave} />;
  }
  const field = SEARCH_ENGINE_API_KEY_FIELDS.find((f) => f.engine === engine);
  if (!field) return null;
  const prefix = settings.webSearchApiKeys?.[field.engine];
  return (
    <WebSearchApiKeyRow
      engine={field.engine}
      patchKey={field.patchKey}
      signupUrl={field.signupUrl}
      prefix={prefix}
      onSave={onSave}
    />
  );
}

function SearxngEndpointRow({
  settings,
  onSave,
}: {
  settings: SettingsType;
  onSave: (patch: SettingsPatch) => void;
}) {
  const [draft, setDraft] = useState(settings.webSearchEndpoint ?? "");
  useEffect(() => {
    setDraft(settings.webSearchEndpoint ?? "");
  }, [settings.webSearchEndpoint]);
  return (
    <div className="setting-row">
      <div className="l">
        <div className="n">{t("settings.webSearchEndpoint")}</div>
        <div className="h">{t("settings.webSearchEndpointHint")}</div>
      </div>
      <input
        className="field mono"
        value={draft}
        placeholder="http://localhost:8080"
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          const next = draft.trim();
          if (next === (settings.webSearchEndpoint ?? "")) return;
          onSave({ webSearchEndpoint: next || null });
        }}
      />
    </div>
  );
}

function WebSearchApiKeyRow({
  engine,
  patchKey,
  signupUrl,
  prefix,
  onSave,
}: {
  engine:
    | "metaso"
    | "baidu"
    | "tavily"
    | "perplexity"
    | "exa"
    | "brave"
    | "ollama"
    | "zai";
  patchKey:
    | "metasoApiKey"
    | "baiduApiKey"
    | "tavilyApiKey"
    | "perplexityApiKey"
    | "exaApiKey"
    | "braveApiKey"
    | "ollamaApiKey"
    | "zaiApiKey";
  signupUrl: string;
  prefix?: string;
  onSave: (patch: SettingsPatch) => void;
}) {
  const [draft, setDraft] = useState("");
  const label = t(`settings.webSearchApiKey.${engine}` as const);
  return (
    <div className="setting-row">
      <div className="l">
        <div className="n">{label}</div>
        <div className="h">
          {prefix ? t("settings.apiKeySet", { prefix }) : t("settings.apiKeyNotSet")}{" "}
          <a
            href={signupUrl}
            target="_blank"
            rel="noreferrer"
            onClick={(e) => {
              e.preventDefault();
              void openUrl(signupUrl).catch(() => undefined);
            }}
          >
            {t("settings.webSearchApiKeySignup")}
          </a>
        </div>
      </div>
      <div style={{ display: "flex", gap: 6 }}>
        <input
          className="field mono"
          type="password"
          value={draft}
          placeholder={prefix ?? ""}
          onChange={(e) => setDraft(e.target.value)}
        />
        <button
          type="button"
          className="btn primary"
          disabled={!draft.trim()}
          onClick={() => {
            const trimmed = draft.trim();
            if (!trimmed) return;
            onSave({ [patchKey]: trimmed } as SettingsPatch);
            setDraft("");
          }}
        >
          {t("settings.apiKeySave")}
        </button>
        {prefix ? (
          <button
            type="button"
            className="btn"
            onClick={() => onSave({ [patchKey]: null } as SettingsPatch)}
          >
            {t("settings.webSearchApiKeyClear")}
          </button>
        ) : null}
      </div>
    </div>
  );
}

function ApiKeySection({
  baseUrl,
  apiKeyPrefix,
  onSave,
  onSaveApiKey,
}: {
  baseUrl?: string;
  apiKeyPrefix?: string;
  onSave: (patch: SettingsPatch) => void;
  onSaveApiKey: (key: string) => void;
}) {
  const [key, setKey] = useState("");
  const [urlDraft, setUrlDraft] = useState(baseUrl ?? "");
  return (
    <section className="section">
      <div className="stitle">{t("settings.apiSection")}</div>
      <div className="setting-row">
        <div className="l">
          <div className="n">{t("settings.apiKey")}</div>
          <div className="h">
            {apiKeyPrefix
              ? t("settings.apiKeySet", { prefix: apiKeyPrefix })
              : t("settings.apiKeyNotSet")}
          </div>
        </div>
        <div style={{ display: "flex", gap: 6 }}>
          <input
            className="field mono"
            type="password"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            placeholder="sk-…"
          />
          <button
            type="button"
            className="btn primary"
            disabled={!key}
            onClick={() => {
              if (!key) return;
              onSaveApiKey(key);
              setKey("");
            }}
          >
            {t("settings.apiKeySave")}
          </button>
        </div>
      </div>
      <div className="setting-row">
        <div className="l">
          <div className="n">{t("settings.baseUrl")}</div>
          <div className="h">{t("settings.baseUrlHint")}</div>
        </div>
        <input
          className="field mono"
          value={urlDraft}
          onChange={(e) => setUrlDraft(e.target.value)}
          onBlur={() => onSave({ baseUrl: urlDraft.trim() })}
        />
      </div>
    </section>
  );
}

export function OpenAISection({
  signedIn,
  account,
  flowError,
  waiting,
  onBegin,
  onCancel,
  onSignOut,
  onSaveApiKey,
}: {
  signedIn: boolean;
  account?: string;
  /** Last OAuth flow failure — shown so a failed sign-in (e.g. upstream invalid_client) is visible instead of just "not signed in". */
  flowError?: string;
  waiting: boolean;
  onBegin: () => void;
  onCancel: () => void;
  onSignOut: () => void;
  onSaveApiKey: (key: string) => void;
}) {
  const [key, setKey] = useState("");
  return (
    <section className="section">
      <div className="stitle">{t("settings.openaiSection")}</div>
      {signedIn ? (
        <div className="setting-row">
          <div className="l">
            <div className="n">{t("settings.openaiSignedIn")}</div>
            <div className="h">
              {account ? t("settings.openaiAccount", { account }) : t("settings.openaiTokenSet")}
            </div>
          </div>
          <button type="button" className="btn" onClick={onSignOut} disabled={waiting}>
            {t("settings.openaiSignOut")}
          </button>
        </div>
      ) : (
        <div className="setting-row">
          <div className="l">
            <div className="n">{t("settings.openaiSignInTitle")}</div>
            <div className="h">
              {waiting ? t("settings.openaiWaiting") : t("settings.openaiSignInHint")}
            </div>
          </div>
          <div style={{ display: "flex", gap: 6 }}>
            {waiting && (
              <button type="button" className="btn" onClick={onCancel}>
                {t("settings.openaiCancel")}
              </button>
            )}
            <button type="button" className="btn primary" onClick={onBegin} disabled={waiting}>
              {t("settings.openaiSignIn")}
            </button>
          </div>
        </div>
      )}
      {flowError ? (
        <div className="setting-row" style={{ borderColor: "var(--danger)" }}>
          <div className="l">
            <div className="n">{t("settings.openaiFlowFailed")}</div>
            <div className="h" style={{ color: "var(--danger)" }}>
              {flowError}
            </div>
          </div>
        </div>
      ) : null}
      <div className="setting-row">
        <div className="l">
          <div className="n">{t("settings.openaiApiKey")}</div>
          <div className="h">{t("settings.openaiApiKeyHint")}</div>
        </div>
        <div style={{ display: "flex", gap: 6 }}>
          <input
            className="field mono"
            type="password"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            placeholder="sk-…"
          />
          <button
            type="button"
            className="btn primary"
            disabled={!key}
            onClick={() => {
              if (!key) return;
              onSaveApiKey(key);
              setKey("");
            }}
          >
            {t("settings.apiKeySave")}
          </button>
        </div>
      </div>
    </section>
  );
}

export function AntigravitySection({
  signedIn,
  account,
  flowError,
  waiting,
  onBegin,
  onCancel,
  onSignOut,
}: {
  signedIn: boolean;
  account?: string;
  /** Last OAuth flow failure — shown so a failed sign-in is visible instead of just "not signed in". */
  flowError?: string;
  waiting: boolean;
  onBegin: () => void;
  onCancel: () => void;
  onSignOut: () => void;
}) {
  return (
    <section className="section">
      <div className="stitle">{t("settings.antigravitySection")}</div>
      {signedIn ? (
        <div className="setting-row">
          <div className="l">
            <div className="n">{t("settings.antigravitySignedIn")}</div>
            <div className="h">
              {account
                ? t("settings.antigravityAccount", { account })
                : t("settings.antigravityTokenSet")}
            </div>
          </div>
          <button type="button" className="btn" onClick={onSignOut} disabled={waiting}>
            {t("settings.antigravitySignOut")}
          </button>
        </div>
      ) : (
        <div className="setting-row">
          <div className="l">
            <div className="n">{t("settings.antigravitySignInTitle")}</div>
            <div className="h">
              {waiting ? t("settings.antigravityWaiting") : t("settings.antigravitySignInHint")}
            </div>
          </div>
          <div style={{ display: "flex", gap: 6 }}>
            {waiting && (
              <button type="button" className="btn" onClick={onCancel}>
                {t("settings.antigravityCancel")}
              </button>
            )}
            <button type="button" className="btn primary" onClick={onBegin} disabled={waiting}>
              {t("settings.antigravitySignIn")}
            </button>
          </div>
        </div>
      )}
      {flowError ? (
        <div className="setting-row" style={{ borderColor: "var(--danger)" }}>
          <div className="l">
            <div className="n">{t("settings.antigravityFlowFailed")}</div>
            <div className="h" style={{ color: "var(--danger)" }}>
              {flowError}
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}

const EFFORT_VALUES = ["low", "medium", "high", "xhigh", "max"] as const;
type EffortValue = (typeof EFFORT_VALUES)[number];

function PageModels({
  settings,
  onSave,
  baseUrl,
  apiKeyPrefix,
  onSaveApiKey,
  ollamaBaseUrl,
  ollamaModels,
  ollamaModelsError,
  ollamaPlan,
  ollamaHiddenCount,
  ollamaVisionModels,
  onRefreshOllamaModels,
  oauthSignedIn,
  oauthAccount,
  oauthFlowError,
  oauthWaiting,
  onOAuthBegin,
  onOAuthCancel,
  onOAuthSignOut,
  onSaveOpenAIApiKey,
  antigravitySignedIn,
  antigravityAccount,
  antigravityFlowError,
  antigravityWaiting,
  onAntigravityBegin,
  onAntigravityCancel,
  onAntigravitySignOut,
}: {
  settings: SettingsType;
  onSave: (patch: SettingsPatch) => void;
  baseUrl?: string;
  apiKeyPrefix?: string;
  onSaveApiKey: (key: string) => void;
  /** Ollama chat endpoint (OpenAI-compatible) shown in the section below. */
  ollamaBaseUrl?: string;
  /** Dynamically fetched Ollama models (raw ids) — rendered as a scrollable grid. */
  ollamaModels?: string[];
  /** Why the last fetch failed — replaces the grid so the failure isn't silent. */
  ollamaModelsError?: string;
  /** The account's Ollama plan (e.g. `free`) when the cloud reported it. */
  ollamaPlan?: string;
  /** Models hidden because the account's plan doesn't cover them. */
  ollamaHiddenCount?: number;
  /** Prefixed vision-capable Ollama ids (`ollama/llava`) — shown as a badge. */
  ollamaVisionModels?: ReadonlySet<string>;
  /** Re-fetch the Ollama model catalog (`force` bypasses the backend's cache). */
  onRefreshOllamaModels?: (force?: boolean) => void;
  oauthSignedIn: boolean;
  oauthAccount?: string;
  oauthFlowError?: string;
  oauthWaiting: boolean;
  onOAuthBegin: () => void;
  onOAuthCancel: () => void;
  onOAuthSignOut: () => void;
  onSaveOpenAIApiKey: (key: string) => void;
  antigravitySignedIn: boolean;
  antigravityAccount?: string;
  antigravityFlowError?: string;
  antigravityWaiting: boolean;
  onAntigravityBegin: () => void;
  onAntigravityCancel: () => void;
  onAntigravitySignOut: () => void;
}) {
  const [draft, setDraft] = useState(settings.model);
  useEffect(() => setDraft(settings.model), [settings.model]);

  type ModelGroup = {
    title: string;
    models: readonly string[];
  };

  const groups: ModelGroup[] = [
    { title: t("composer.modelDeepSeekGroup"), models: SUPPORTED_OFFICIAL_MODELS },
    { title: t("composer.modelOpenAIGroup"), models: GPT56_MODELS },
    { title: t("composer.modelZaiGroup"), models: ZAI_MODELS },
    ...(settings.customModels && settings.customModels.length > 0
      ? [{ title: t("composer.modelCustomGroup"), models: settings.customModels }]
      : []),
    ...(settings.antigravityOAuth?.signedIn ||
    (settings.antigravityOAuth?.models &&
      settings.antigravityOAuth.models.filter(isUsableAntigravityModel).length > 0)
      ? [
          {
            title: t("composer.modelAntigravityGroup"),
            models: Array.from(
              new Set([
                ...(settings.antigravityOAuth?.models?.filter(isUsableAntigravityModel) ?? []),
                ...ANTIGRAVITY_MODELS,
              ]),
            ),
          },
        ]
      : []),
  ];

  const allAvailable = groups.flatMap((g) => g.models);
  const isKnown = allAvailable.includes(settings.model);
  return (
    <>
      <section className="section">
        <div className="stitle">{t("settings.defaultModelCurrent", { model: settings.model })}</div>
        {groups.map((g) => (
          <div key={g.title} style={{ marginBottom: 12 }}>
            <div className="h" style={{ fontWeight: 600, marginBottom: 6 }}>{g.title}</div>
            <div className="model-grid">
              {g.models.map((id) => (
                <div
                  key={id}
                  className="mcard"
                  data-on={settings.model === id}
                  onClick={() => onSave({ model: id })}
                  onKeyDown={activationHandler(() => onSave({ model: id }))}
                >
                  <div className="nm">{modelDisplayName(id)}</div>
                  {modelAcceptsImages(id, ollamaVisionModels) ? (
                    <span className="badge">vision</span>
                  ) : null}
                </div>
              ))}
            </div>
          </div>
        ))}
        <div className="setting-row" style={{ marginTop: 12 }}>
          <div className="l">
            <div className="n">{t("settings.modelCustom")}</div>
            <div className="h">{t("settings.modelCustomHint")}</div>
          </div>
          <div style={{ display: "flex", gap: 6 }}>
            <input
              className="field mono"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="deepseek-v4-flash"
            />
            <button
              type="button"
              className="btn primary"
              disabled={!draft.trim() || draft.trim() === settings.model}
              onClick={() => onSave({ model: draft.trim() })}
            >
              {t("settings.apiKeySave")}
            </button>
          </div>
        </div>
        {!isKnown ? (
          <div className="h" style={{ marginTop: 6 }}>
            {t("settings.modelCustomActive", { model: settings.model })}
          </div>
        ) : null}
      </section>
      <section className="section">
        <div className="stitle">Z.AI / GLM</div>
        <WebSearchApiKeyRow
          engine="zai"
          patchKey="zaiApiKey"
          signupUrl="https://z.ai/manage-apikey/apikey-list"
          prefix={settings.webSearchApiKeys?.zai}
          onSave={onSave}
        />
      </section>
      <section className="section">
        <div className="stitle">{t("settings.ollamaSection")}</div>
        <div className="setting-row">
          <div className="l">
            <div className="n">{t("settings.ollamaBaseUrl")}</div>
            <div className="h">{t("settings.ollamaBaseUrlHint")}</div>
          </div>
          <input
            className="field mono"
            defaultValue={ollamaBaseUrl ?? ""}
            placeholder={t("settings.ollamaBaseUrlPlaceholder")}
            onBlur={(e) => {
              const next = e.target.value.trim();
              if (next === (ollamaBaseUrl ?? "")) return;
              onSave({ ollamaBaseUrl: next || null });
            }}
          />
        </div>
        <WebSearchApiKeyRow
          engine="ollama"
          patchKey="ollamaApiKey"
          signupUrl="https://ollama.com/settings/keys"
          prefix={settings.webSearchApiKeys?.ollama}
          onSave={onSave}
        />
        <div className="setting-row">
          <div className="l">
            <div className="n">{t("settings.ollamaModels")}</div>
            <div className="h">
              {ollamaModelsError
                ? t("settings.ollamaModelsError", { error: ollamaModelsError })
                : t("settings.ollamaModelsHint")}
            </div>
          </div>
          <button type="button" className="btn" onClick={() => onRefreshOllamaModels?.(true)}>
            {t("settings.ollamaModelsRefresh")}
          </button>
        </div>
        {ollamaHiddenCount && ollamaHiddenCount > 0 ? (
          <div className="h" style={{ marginTop: 4 }}>
            {t("settings.ollamaSubscription", {
              count: ollamaHiddenCount,
              plan: ollamaPlan ?? "free",
            })}
          </div>
        ) : ollamaPlan ? (
          <div className="h" style={{ marginTop: 4 }}>
            {t("settings.ollamaPlan", { plan: ollamaPlan })}
          </div>
        ) : null}
        {ollamaModels && ollamaModels.length > 0 ? (
          <div className="model-grid ollama-model-grid">
            {ollamaModels.map((id) => {
              const full = `ollama/${id}`;
              return (
                <div
                  key={full}
                  className="mcard"
                  data-on={settings.model === full}
                  onClick={() => onSave({ model: full })}
                  onKeyDown={activationHandler(() => onSave({ model: full }))}
                >
                  <div className="nm">{full}</div>
                  {modelAcceptsImages(full, ollamaVisionModels) ? (
                    <span className="badge">vision</span>
                  ) : null}
                </div>
              );
            })}
          </div>
        ) : null}
      </section>
      <section className="section">
        <div className="stitle">{t("settings.effortSection")}</div>
        <div className="setting-row">
          <div className="l">
            <div className="n">{t("settings.reasoningEffort")}</div>
            <div className="h">{t("settings.reasoningEffortHint")}</div>
          </div>
          <div className="seg-ctrl">
            {EFFORT_VALUES.map((e) => (
              <button
                type="button"
                key={e}
                data-on={settings.reasoningEffort === e}
                onClick={() => onSave({ reasoningEffort: e as EffortValue })}
              >
                {e}
              </button>
            ))}
          </div>
        </div>
      </section>
      <ApiKeySection
        baseUrl={baseUrl}
        apiKeyPrefix={apiKeyPrefix}
        onSave={onSave}
        onSaveApiKey={onSaveApiKey}
      />
      <OpenAISection
        signedIn={oauthSignedIn}
        account={oauthAccount}
        flowError={oauthFlowError}
        waiting={oauthWaiting}
        onBegin={onOAuthBegin}
        onCancel={onOAuthCancel}
        onSignOut={onOAuthSignOut}
        onSaveApiKey={onSaveOpenAIApiKey}
      />
      <AntigravitySection
        signedIn={antigravitySignedIn}
        account={antigravityAccount}
        flowError={antigravityFlowError}
        waiting={antigravityWaiting}
        onBegin={onAntigravityBegin}
        onCancel={onAntigravityCancel}
        onSignOut={onAntigravitySignOut}
      />
    </>
  );
}

function PageMCP({
  specs,
  bridged,
  onAdd,
  onRemove,
}: {
  specs: McpSpecInfo[];
  bridged: boolean;
  onAdd: (spec: string) => void;
  onRemove: (spec: string) => void;
}) {
  const [draft, setDraft] = useState("");
  const submit = () => {
    const v = draft.trim();
    if (!v) return;
    onAdd(v);
    setDraft("");
  };
  return (
    <>
      <section className="section">
        <div className="stitle">
          {t("settings.mcpConfigured", { count: specs.length })}
          {bridged ? (
            <span style={{ color: "var(--accent)", marginLeft: 8, fontSize: 11 }}>
              {t("settings.mcpBridged")}
            </span>
          ) : (
            <span style={{ color: "var(--muted)", marginLeft: 8, fontSize: 11 }}>
              {t("settings.mcpNotBridged")}
            </span>
          )}
        </div>
        {specs.length === 0 ? (
          <div
            style={{
              padding: 16,
              background: "var(--card)",
              border: "1px solid var(--border)",
              borderRadius: 10,
              fontSize: 12,
              color: "var(--muted)",
            }}
          >
            {t("settings.mcpEmpty")}
          </div>
        ) : (
          specs.map((s) => (
            <div className="scard" key={s.raw}>
              <div className="top">
                <span className="ico">
                  <I.wrench size={14} />
                </span>
                <div className="mcp-spec-body">
                  <div className="nm">{s.name ?? "(anonymous)"}</div>
                  <div className="sub mcp-spec-summary" title={s.summary}>
                    {s.summary}
                  </div>
                </div>
                <button
                  type="button"
                  className="btn ghost mcp-remove"
                  style={{ color: "var(--danger)" }}
                  onClick={() => onRemove(s.raw)}
                >
                  {t("settings.mcpRemove")}
                </button>
              </div>
              {s.parseError ? (
                <div className="desc" style={{ color: "var(--danger)" }}>
                  {t("settings.parseError", { error: s.parseError })}
                </div>
              ) : null}
            </div>
          ))
        )}
      </section>
      <section className="section">
        <div className="stitle">{t("settings.mcpAddSection")}</div>
        <div className="setting-row">
          <div className="l">
            <div className="n">{t("settings.mcpSpecLabel")}</div>
            <div className="h">{hintNodes(t("settings.mcpSpecFormat"))}</div>
          </div>
          <div style={{ display: "flex", gap: 6 }}>
            <input
              className="field mono"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="github=npx -y @smithery/cli ..."
              onKeyDown={(e) => {
                if (e.key === "Enter") submit();
              }}
            />
            <button type="button" className="btn primary" disabled={!draft.trim()} onClick={submit}>
              {t("settings.mcpAdd")}
            </button>
          </div>
        </div>
      </section>
    </>
  );
}

function PageMemory({
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
    <section className="section">
      <div className="stitle">
        {t("settings.memorySection")}
        <span className="mem-actions">
          <button type="button" className="btn small" onClick={onExport}>
            ⇪ {t("contextPanel.saveLabel")}
          </button>
          <button type="button" className="btn small" onClick={() => fileRef.current?.click()}>
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
        <div className="muted-card">{t("settings.memoryDesc")}</div>
      ) : (
        <div className="memory-browser">
          <div className="memory-list">
            {entries.map((m) => (
              <div
                className="memory-item"
                data-active={detail?.path === m.path}
                key={m.path}
                onClick={() => onRead(m.path)}
                onKeyDown={activationHandler(() => onRead(m.path))}
              >
                <span className="memory-kind">{m.kind.replace("_", " ")}</span>
                <span className="memory-name">{m.description || m.name}</span>
                <span className="memory-path">{m.path}</span>
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
          <pre className="memory-detail">{detail ? detail.body : t("settings.memoryDesc")}</pre>
        </div>
      )}

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
        <button type="button" className="btn small" onClick={() => setComposing(true)}>
          ＋ {t("contextPanel.newMemory")}
        </button>
      )}
    </section>
  );
}

function PageRules({
  settings,
  onSave,
  onAddRule,
  onRemoveRule,
}: {
  settings: SettingsType;
  onSave: (patch: SettingsPatch) => void;
  onAddRule?: (ruleType: "shell" | "path", pattern: string) => void;
  onRemoveRule?: (ruleType: "shell" | "path", pattern: string) => void;
}) {
  const [ruleType, setRuleType] = useState<"shell" | "path">("shell");
  const [pattern, setPattern] = useState("");

  const shellRules = settings.shellAllowed ?? [];
  const pathRules = settings.pathAllowed ?? [];
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
      <section className="section">
        <div className="stitle">{t("settings.editMode")}</div>
        <div className="setting-row">
          <div className="l">
            <div className="n">{t("settings.appMode")}</div>
            <div className="h">{t("settings.editModeHint")}</div>
          </div>
          <div className="seg-ctrl">
            {(["plan", "review", "auto", "yolo"] as const).map((m) => (
              <button
                type="button"
                key={m}
                data-on={settings.editMode === m}
                onClick={() => onSave({ editMode: m })}
              >
                {m}
              </button>
            ))}
          </div>
        </div>
      </section>
      <section className="section">
        <div className="stitle">{t("settings.ruleAutoApprovalSection")}</div>
        <div
          style={{
            padding: 12,
            background: "var(--card)",
            border: "1px solid var(--border)",
            borderRadius: 10,
            fontSize: 12,
            color: "var(--muted)",
            marginBottom: 12,
          }}
        >
          {t("settings.ruleAutoApprovalHint")}
        </div>

        {totalCustom > 0 && (
          <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 12 }}>
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
                        title={t("settings.deleteRuleTooltip")}
                        aria-label={`Remove rule: ${r}`}
                        onClick={() => onRemoveRule("shell", r)}
                      >
                        <I.trash size={12} />
                      </button>
                    )}
                  </div>
                </div>
                <div className="desc">{t("settings.ruleTypeShell")}</div>
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
                        title={t("settings.deleteRuleTooltip")}
                        aria-label={`Remove rule: ${r}`}
                        onClick={() => onRemoveRule("path", r)}
                      >
                        <I.trash size={12} />
                      </button>
                    )}
                  </div>
                </div>
                <div className="desc">{t("settings.ruleTypePath")}</div>
              </div>
            ))}
          </div>
        )}

        {totalCustom === 0 && (
          <div style={{ color: "var(--muted)", fontSize: 12, marginBottom: 12 }}>
            {t("settings.noCustomRules")}
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
                <option value="shell">{t("settings.ruleTypeShell")}</option>
                <option value="path">{t("settings.ruleTypePath")}</option>
              </select>
              <input
                type="text"
                className="rule-input"
                placeholder={t("settings.rulePatternPlaceholder")}
                value={pattern}
                onChange={(e) => setPattern(e.target.value)}
                aria-label="Rule pattern"
              />
              <button
                type="submit"
                className="btn small"
                disabled={!pattern.trim()}
                title={t("settings.addRule")}
                aria-label={t("settings.addRule")}
              >
                <I.plus size={12} />
                <span style={{ marginLeft: 4 }}>{t("settings.addRule")}</span>
              </button>
            </div>
          </form>
        )}
      </section>
    </>
  );
}

function PageBilling({
  balance,
  usage,
  currency,
}: {
  balance: Balance | null;
  usage: UsageStats;
  currency: "CNY" | "USD";
}) {
  const symbol = currency === "CNY" ? "¥" : "$";
  const totalTokens = usage.cacheHitTokens + usage.cacheMissTokens;
  const hitPct = totalTokens > 0 ? Math.round((usage.cacheHitTokens / totalTokens) * 100) : 0;
  // Per-provider native-unit costs: USD-kind providers show a dollar figure,
  // quota-kind providers show the accumulated plan-window %. Never converted
  // between the two.
  const providerCosts = Object.entries(usage.costByProvider ?? {}).filter(
    ([, cost]) => (cost.totalCostUsd ?? 0) > 0 || (cost.quotaUsedPct ?? 0) > 0,
  );
  return (
    <>
      <div className="bill-grid">
        <div className="bill-card">
          <div className="l">{t("settings.balanceLabel")}</div>
          <div className="v ok">
            {balance
              ? `${balance.currency === "USD" ? "$" : "¥"} ${balance.total.toFixed(2)}`
              : "—"}
          </div>
          <div className="sub">
            {balance && !balance.isAvailable
              ? t("settings.balanceLow")
              : t("settings.balanceAvailable")}
          </div>
        </div>
        <div className="bill-card">
          <div className="l">{t("settings.sessionCost")}</div>
          <div className="v">
            {providerCosts.length === 0 ? (
              "—"
            ) : (
              <span className="provider-costs">
                {providerCosts.map(([provider, cost]) => (
                  <span key={provider} className="provider-cost">
                    {provider}:{" "}
                    {cost.kind === "quota"
                      ? `${(cost.quotaUsedPct ?? 0).toFixed(2)}%`
                      : `${symbol} ${(currency === "CNY" ? (cost.totalCostUsd ?? 0) * 7.2 : (cost.totalCostUsd ?? 0)).toFixed(4)}`}
                  </span>
                ))}
              </span>
            )}
          </div>
          <div className="sub">prompt {usage.totalPromptTokens.toLocaleString()} t</div>
        </div>
        <div className="bill-card">
          <div className="l">{t("settings.cacheHitRate")}</div>
          <div className="v acc">{hitPct}%</div>
          <div className="sub">
            hit {usage.cacheHitTokens.toLocaleString()} / miss{" "}
            {usage.cacheMissTokens.toLocaleString()}
          </div>
        </div>
      </div>
    </>
  );
}

function PageShortcuts() {
  const rows: { nm: string; keys: ShortcutKey[] }[] = [
    { nm: t("settings.shortcutNewChat"), keys: ["mod", "N"] },
    { nm: t("settings.shortcutNewTab"), keys: ["mod", "T"] },
    { nm: t("settings.shortcutCloseTab"), keys: ["mod", "W"] },
    { nm: t("settings.shortcutFocusComposer"), keys: ["mod", "L"] },
    { nm: t("settings.shortcutSwitchTab"), keys: ["mod", "tab"] },
    { nm: t("settings.shortcutAbort"), keys: ["esc"] },
    { nm: t("settings.shortcutSettings"), keys: ["mod", ","] },
  ];
  return (
    <section className="section">
      <div className="kbd-grid">
        {rows.map((s, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: static shortcut rows snapshot
          <SectionRow key={i} nm={s.nm} keys={s.keys} />
        ))}
      </div>
    </section>
  );
}

function SectionRow({ nm, keys }: { nm: string; keys: ShortcutKey[] }): ReactNode {
  return (
    <>
      <div className="nm">{nm}</div>
      <div className="keys">
        <Shortcut keys={keys} />
      </div>
    </>
  );
}
