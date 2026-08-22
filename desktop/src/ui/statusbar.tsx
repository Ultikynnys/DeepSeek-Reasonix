import { useEffect, useRef, useState } from "react";
import type { Balance, Settings, UsageStats } from "../App";
import { t } from "../i18n";
import { I } from "../icons";
import { isOffPeak, minutesUntilRateChange } from "../peak-hours";
import type { CodexQuota, JobInfo, OllamaQuota } from "../protocol";
import { THEME, THEME_STYLES, type Theme, type ThemeStyle, themeForStyle } from "../theme";
import { activationHandler } from "./keyboard";
import { localizeShortcutText } from "./shortcut";

const USD_TO_CNY = 7.2;

function formatMoney(amountUsd: number, currency: "CNY" | "USD"): string {
  const symbol = currency === "CNY" ? "¥" : "$";
  const amount = currency === "CNY" ? amountUsd * USD_TO_CNY : amountUsd;
  return `${symbol} ${amount.toFixed(4)}`;
}

function tokenLabel(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return `${n}`;
}

export function StatusBar({
  settings,
  balance,
  codexQuota,
  onRefreshCodexQuota,
  codexQuotaRefreshing,
  codexQuotaReason,
  ollamaQuota,
  onRefreshOllamaQuota,
  ollamaQuotaRefreshing,
  ollamaQuotaReason,
  ollamaPlan,
  usage,
  busy,
  ready,
  currency,
  theme,
  themeStyle,
  jobs,
  jobsOpen,
  onToggleJobs,
  onSetThemeStyle,
  onToggleCurrency,
  onOpenSettings,
  onOpenWorkdir,
}: {
  settings: Settings | null;
  balance: Balance | null;
  codexQuota: CodexQuota | null;
  onRefreshCodexQuota?: () => void;
  /** True between a chip click and the $codex_quota reply — renders a refresh indicator. */
  codexQuotaRefreshing?: boolean;
  /** Why the last quota fetch produced no data — appended to the chip tooltip. */
  codexQuotaReason?: string | null;
  /** Cloud Ollama usage — mirrors codexQuota for the Ollama provider. */
  ollamaQuota: OllamaQuota | null;
  onRefreshOllamaQuota?: () => void;
  ollamaQuotaRefreshing?: boolean;
  ollamaQuotaReason?: string | null;
  /** The account's Ollama plan (e.g. `free`) — labels the usage chip. */
  ollamaPlan?: string | null;
  usage: UsageStats;
  busy: boolean;
  ready: boolean;
  currency: "CNY" | "USD";
  theme: Theme;
  themeStyle: ThemeStyle;
  jobs: JobInfo[];
  jobsOpen: boolean;
  onToggleJobs: () => void;
  onSetThemeStyle: (style: ThemeStyle) => void;
  onToggleCurrency: () => void;
  onOpenSettings: () => void;
  onOpenWorkdir?: (anchor: { bottom: number; left: number }) => void;
}) {
  const sessionPromptTokens =
    usage.totalPromptTokens || usage.cacheHitTokens + usage.cacheMissTokens;
  const liveContextTokens = usage.reservedTokens + usage.liveLogTokens;
  const totalTokens = Math.max(sessionPromptTokens, liveContextTokens);
  const cacheDenom = usage.cacheHitTokens + usage.cacheMissTokens;
  const cacheHitPct = cacheDenom > 0 ? Math.round((usage.cacheHitTokens / cacheDenom) * 100) : 0;
  const runningJobs = jobs.filter((j) => j.running).length;
  const spent = formatMoney(usage.totalCostUsd, currency);
  // Dual-currency: keep the primary display currency and show the conversion
  // to the other one right next to it (¥ primary → $ conversion by default).
  const spentOther = formatMoney(usage.totalCostUsd, currency === "CNY" ? "USD" : "CNY");
  const balanceLabel = balance
    ? `${balance.currency === "USD" ? "$" : "¥"} ${balance.total.toFixed(2)}`
    : "—";
  const connState = !ready ? "off" : busy ? "running" : "online";
  const ep = settings?.modelEndpoint;
  const apiHost =
    ep?.baseUrl?.replace(/^https?:\/\//, "") ??
    settings?.baseUrl?.replace(/^https?:\/\//, "") ??
    "api.deepseek.com";
  // Per-tab provider state: DeepSeek tabs show the DeepSeek endpoint, gpt-*
  // tabs show the OpenAI endpoint and its auth source (OAuth > static key > none).
  const openaiAuth = ep?.provider === "openai" ? (ep.openaiAuth ?? "none") : null;
  const oauthFlowError = openaiAuth !== null ? settings?.openaiOAuth?.flowError : undefined;
  const authFailed = openaiAuth !== null && !!oauthFlowError;
  const authLabel =
    openaiAuth === "oauth"
      ? t("statusbar.authOauth")
      : openaiAuth === "apiKey"
        ? t("statusbar.authKey")
        : openaiAuth === "none"
          ? t("statusbar.authNone")
          : null;
  let apiTitle =
    openaiAuth === "oauth"
      ? t("statusbar.apiOpenaiOauth", {
          baseUrl: ep?.baseUrl ?? "",
          account: ep?.oauthAccount ?? "",
        })
      : openaiAuth === "apiKey"
        ? t("statusbar.apiOpenaiKey", { baseUrl: ep?.baseUrl ?? "" })
        : openaiAuth === "none"
          ? t("statusbar.apiOpenaiNone", { baseUrl: ep?.baseUrl ?? "" })
          : ep?.provider === "ollama"
            ? t("statusbar.apiOllama", { baseUrl: ep.baseUrl })
            : `API · ${settings?.baseUrl ?? "api.deepseek.com"}`;
  if (authFailed) apiTitle += `\n${t("statusbar.oauthFailed", { message: oauthFlowError })}`;
  const dotDanger = connState === "off" || authFailed;
  const dotWarn = !dotDanger && openaiAuth === "none";
  // OpenAI tabs swap the balance / $ display for the API-reported weekly
  // Codex quota: % + credits left, and this turn's cost as % of the weekly
  // limit (delta between fetches — OpenAI reports no dollar amounts). The
  // swap happens for every gpt-* model (matches providerForModel), and even
  // without quota data the chips render an em dash + retry hint — the
  // DeepSeek balance and $ amounts are meaningless on an OpenAI tab.
  const openaiTab = !!settings?.model?.startsWith("gpt-");
  const quota = codexQuota && openaiTab ? codexQuota : null;
  const showQuota = !!quota;
  const quotaWeekly = quota?.weekly ?? null;
  const quotaFiveHour = quota?.fiveHour ?? null;
  // Official app-server format: windows carry remainingPercent (100 - usedPercent)
  // and an ISO resetsAt — the chip shows "% left" + plan, no credit amounts.
  const quotaLeftPct = quotaWeekly ? Math.round(quotaWeekly.remainingPercent) : 0;
  const quotaTurnPct = quota?.turnUsedPct ?? null;
  const ollamaTab = !!settings?.model?.startsWith("ollama/");
  const ollamaQuotaData = ollamaQuota && ollamaTab ? ollamaQuota : null;
  const ollamaWeekly = ollamaQuotaData?.weekly ?? null;
  const ollamaSession = ollamaQuotaData?.session ?? null;
  const ollamaTurnPct = ollamaQuotaData?.turnUsedPct ?? null;
  const ollamaQuotaTitle =
    ollamaQuotaData && ollamaWeekly
      ? t("statusbar.ollamaQuotaTitle", {
          left: Math.round(ollamaWeekly.remainingPct),
          session: ollamaSession ? Math.round(ollamaSession.remainingPct) : "—",
        })
      : t("statusbar.ollamaNoData");
  // A failed fetch stays diagnosable: append the reason to the tooltip.
  const ollamaQuotaTitleWithReason =
    !ollamaQuotaData && ollamaQuotaReason
      ? `${ollamaQuotaTitle}\n${t("statusbar.codexReason", { reason: ollamaQuotaReason })}`
      : ollamaQuotaTitle;
  const quotaTitle = quotaWeekly
    ? t("statusbar.codexQuotaTitle", {
        left: quotaLeftPct,
        resets: quotaWeekly.resetsAt ? new Date(quotaWeekly.resetsAt).toLocaleString() : "—",
        plan: quota?.plan ?? "ChatGPT",
      }) +
      (quotaFiveHour
        ? `\n${t("statusbar.codexFiveHourTitle", { left: Math.round(quotaFiveHour.remainingPercent) })}`
        : "")
    : t("statusbar.codexNoData");
  // A failed fetch stays diagnosable: append the app-server reason to the tooltip.
  const quotaTitleWithReason =
    !showQuota && codexQuotaReason
      ? `${quotaTitle}\n${t("statusbar.codexReason", { reason: codexQuotaReason })}`
      : quotaTitle;
  useEffect(() => {
    const renderState = {
      openaiTab,
      ollamaTab,
      showQuota,
      hasWeeklyWindow: quotaWeekly !== null,
      hasFiveHourWindow: quotaFiveHour !== null,
      turnUsedPct: quotaTurnPct,
      ollamaTurnPct,
      weeklyRemainingPct: quotaWeekly?.remainingPercent ?? null,
      refreshing: codexQuotaRefreshing,
      reason: codexQuotaReason,
    };
    const level =
      (quotaTurnPct === null && openaiTab) || (ollamaTurnPct === null && ollamaTab)
        ? "warn"
        : "debug";
    if (level === "warn") console.warn("[reasonix frontend] statusbar quota render", renderState);
    else console.debug("[reasonix frontend] statusbar quota render", renderState);
  }, [
    openaiTab,
    ollamaTab,
    showQuota,
    quotaWeekly,
    quotaFiveHour,
    quotaTurnPct,
    ollamaTurnPct,
    codexQuotaRefreshing,
    codexQuotaReason,
  ]);
  // Rate period (peak / off-peak) — this turn's pricing depends on the UTC
  // hour and whether the Beijing day is a weekend (off-peak all day), so the
  // chip re-evaluates on a short tick instead of only on parent re-renders
  // (the parent has no per-minute state of its own).
  const [rateNow, setRateNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setRateNow(new Date()), 30_000);
    return () => clearInterval(id);
  }, []);
  const offPeak = isOffPeak(rateNow);
  const rateMins = minutesUntilRateChange(rateNow);
  // Weekends push the next change past a full day — render "2d 9h" instead of
  // a raw "3420 min".
  const when =
    rateMins >= 1440
      ? `${Math.floor(rateMins / 1440)}d ${Math.floor((rateMins % 1440) / 60)}h`
      : rateMins >= 60
        ? `${Math.floor(rateMins / 60)}h ${rateMins % 60}m`
        : `${rateMins}m`;
  const rateTitle = offPeak
    ? t("statusbar.offPeakTitle", { when })
    : t("statusbar.peakTitle", { when });
  const [themeOpen, setThemeOpen] = useState(false);
  const themePopRef = useRef<HTMLDivElement | null>(null);
  const themeButtonRef = useRef<HTMLSpanElement | null>(null);

  useEffect(() => {
    if (!themeOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (themePopRef.current?.contains(target) || themeButtonRef.current?.contains(target)) return;
      setThemeOpen(false);
    };
    window.addEventListener("pointerdown", onPointerDown);
    return () => window.removeEventListener("pointerdown", onPointerDown);
  }, [themeOpen]);

  return (
    <footer className="statusbar">
      <span className="seg" title={apiTitle}>
        <span
          className={dotDanger || dotWarn ? "sw warn" : "sw"}
          style={
            dotDanger
              ? { background: "var(--danger)" }
              : dotWarn
                ? { background: "var(--warn)" }
                : undefined
          }
        />
        <span>{apiHost}</span>
        {authLabel ? <span className="v">{authLabel}</span> : null}
        <span className="v">
          {!ready ? t("statusbar.offline") : busy ? t("statusbar.busy") : t("statusbar.online")}
        </span>
      </span>
      <span className="seg" title={t("statusbar.cacheHit")}>
        <I.zap size={11} style={{ color: "var(--accent)" }} />
        <span>{t("statusbar.cache")}</span>
        <span className="v acc">{cacheHitPct}%</span>
      </span>
      <span className="seg">
        <I.cpu size={11} />
        <span>{t("statusbar.tokens")}</span>
        <span className="v">{tokenLabel(totalTokens)}</span>
      </span>
      <span
        className="seg"
        title={
          quotaTurnPct != null
            ? t("statusbar.thisTurnQuotaTitle", { pct: quotaTurnPct.toFixed(1) })
            : ollamaTurnPct != null
              ? t("statusbar.ollamaTurnQuotaTitle", { pct: ollamaTurnPct.toFixed(1) })
              : undefined
        }
      >
        <I.coin size={11} />
        <span>{t("statusbar.thisTurn")}</span>
        {openaiTab ? (
          quotaTurnPct != null ? (
            <span className="v ok">{quotaTurnPct.toFixed(1)}%</span>
          ) : (
            <span className="v ok">—</span>
          )
        ) : ollamaTab ? (
          ollamaTurnPct != null ? (
            <span className="v ok">{ollamaTurnPct.toFixed(1)}%</span>
          ) : (
            <span className="v ok">—</span>
          )
        ) : (
          <span className="v ok">
            {spent}
            <span className="conv">{`(${spentOther})`}</span>
          </span>
        )}
      </span>

      <span className="seg" title={rateTitle}>
        <I.clock size={11} style={{ color: offPeak ? "var(--success)" : "var(--warning)" }} />
        <span className={`v ${offPeak ? "ok" : "warn"}`}>
          {offPeak ? t("statusbar.offPeak") : t("statusbar.peak")}
          <span className="conv">{offPeak ? "1x" : "2x"}</span>
        </span>
      </span>

      <span className="grow" />

      <span
        className={`seg jobs ${jobsOpen ? "active" : ""}`}
        onClick={onToggleJobs}
        onKeyDown={onToggleJobs ? activationHandler(onToggleJobs) : undefined}
        title={localizeShortcutText(t("statusbar.jobsTip"))}
      >
        <I.cpu size={11} />
        <span>{t("statusbar.jobs")}</span>
        <span className={runningJobs > 0 ? "v acc" : "v"}>{runningJobs}</span>
      </span>

      {settings?.workspaceDir ? (
        <span
          className="seg"
          title={t("statusbar.switchWorkspace", { workspace: settings.workspaceDir })}
          style={onOpenWorkdir ? { cursor: "pointer" } : undefined}
          onClick={(e) => {
            if (!onOpenWorkdir) return;
            const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
            onOpenWorkdir({ bottom: window.innerHeight - r.top + 6, left: r.left });
          }}
          onKeyDown={activationHandler((e) => {
            if (!onOpenWorkdir) return;
            const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
            onOpenWorkdir({ bottom: window.innerHeight - r.top + 6, left: r.left });
          })}
        >
          <I.folder size={11} />
          <span className="v">{settings.workspaceDir.split(/[\\/]/).pop() || "ws"}</span>
        </span>
      ) : null}
      <span
        className="seg"
        title={`model · effort ${settings?.reasoningEffort ?? "high"}`}
        onClick={onOpenSettings}
        onKeyDown={activationHandler(onOpenSettings)}
      >
        <I.brain size={11} style={{ color: "var(--violet)" }} />
        <span className="v vio">{settings?.model ?? "—"}</span>
        <span className="v">{settings?.reasoningEffort ?? "high"}</span>
      </span>
      {openaiTab ? (
        <span
          className="seg"
          title={quotaTitleWithReason}
          style={onRefreshCodexQuota ? { cursor: "pointer" } : undefined}
          onClick={onRefreshCodexQuota}
          onKeyDown={onRefreshCodexQuota ? activationHandler(onRefreshCodexQuota) : undefined}
        >
          <I.coin size={11} style={{ color: "var(--accent)" }} />
          <span>{t("statusbar.codexQuota")}</span>
          {showQuota && quotaWeekly ? (
            <>
              <span className="v acc">
                {quotaLeftPct}% {t("statusbar.codexLeft")}
              </span>
              <span className="conv">{quota?.plan ?? "ChatGPT"}</span>
            </>
          ) : codexQuotaRefreshing ? (
            <span className="v acc">{t("statusbar.codexRefreshing")}</span>
          ) : (
            <span className="v acc">—</span>
          )}
        </span>
      ) : ollamaTab ? (
        <span
          className="seg"
          title={ollamaQuotaTitleWithReason}
          style={onRefreshOllamaQuota ? { cursor: "pointer" } : undefined}
          onClick={onRefreshOllamaQuota}
          onKeyDown={onRefreshOllamaQuota ? activationHandler(onRefreshOllamaQuota) : undefined}
        >
          <I.coin size={11} style={{ color: "var(--accent)" }} />
          <span>{t("statusbar.ollamaQuota")}</span>
          {ollamaQuotaData && ollamaWeekly ? (
            <>
              <span className="v acc">
                {Math.round(ollamaWeekly.remainingPct)}% {t("statusbar.codexLeft")}
              </span>
              <span className="conv">{ollamaPlan ?? "free"}</span>
            </>
          ) : ollamaQuotaRefreshing ? (
            <span className="v acc">{t("statusbar.codexRefreshing")}</span>
          ) : (
            <span className="v acc">—</span>
          )}
        </span>
      ) : (
        <span
          className="seg"
          title={t("statusbar.switchCurrency")}
          onClick={onToggleCurrency}
          onKeyDown={activationHandler(onToggleCurrency)}
        >
          <I.coin size={11} />
          <span>{t("statusbar.balance")}</span>
          <span className="v ok">
            {balance && balance.infos.length > 0
              ? balance.infos
                  .map((info) => `${info.currency === "USD" ? "$" : "¥"} ${info.total.toFixed(2)}`)
                  .join(" / ")
              : balanceLabel}
          </span>
        </span>
      )}
      <span
        ref={themeButtonRef}
        className={`seg theme-trigger ${themeOpen ? "active" : ""}`}
        title={t("statusbar.switchTheme")}
        onClick={() => setThemeOpen((open) => !open)}
        onKeyDown={activationHandler(() => setThemeOpen((open) => !open))}
      >
        {theme === THEME.DARK ? <I.moon size={11} /> : <I.sun size={11} />}
        <span className="v">
          {t(`statusbar.themeStyle${themeStyle[0]!.toUpperCase()}${themeStyle.slice(1)}` as any)}
        </span>
      </span>
      {themeOpen ? (
        <div
          ref={themePopRef}
          className="theme-pop"
          role="menu"
          aria-label={t("settings.themeStyle")}
        >
          <div className="theme-pop-head">
            <div className="tt">{t("settings.themeStyle")}</div>
            <div className="ss">{t("statusbar.switchTheme")}</div>
          </div>
          <div className="theme-pop-list">
            {THEME_STYLES.map((style) => (
              <button
                key={style}
                type="button"
                className="theme-pop-item"
                data-on={themeStyle === style}
                data-style={style}
                onClick={() => {
                  onSetThemeStyle(style);
                  setThemeOpen(false);
                }}
              >
                <span className="style-swatches" aria-hidden="true">
                  <span />
                  <span />
                  <span />
                </span>
                <span className="txt">
                  <span className="nm">
                    {t(`statusbar.themeStyle${style[0]!.toUpperCase()}${style.slice(1)}` as any)}
                  </span>
                  <span className="md">
                    {themeForStyle(style) === THEME.DARK
                      ? t("statusbar.themeDark")
                      : t("statusbar.themeLight")}
                  </span>
                </span>
                {themeStyle === style ? <I.check size={13} /> : null}
              </button>
            ))}
          </div>
        </div>
      ) : null}
    </footer>
  );
}
