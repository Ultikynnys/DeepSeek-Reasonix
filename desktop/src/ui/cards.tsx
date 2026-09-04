import { type ReactNode, memo, useContext, useMemo, useState } from "react";
import { Markdown, WorkspaceContext, resolveAgainstWorkspace, revealInExplorer } from "../Markdown";
import { t, useLang } from "../i18n";
import { I } from "../icons";
import { FileMenu } from "./file-menu";
import { Shortcut } from "./shortcut";

type Tone = "default" | "success" | "warning" | "danger" | "accent" | "violet";

function tokenLabel(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}m`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}k`;
  return tokens.toLocaleString();
}

/** Pull a file ref (path + optional line) out of a tool's JSON args, mirroring the TUI ToolCard ↗ link. */
function extractToolFileRef(args?: string): { path: string; line?: number } | null {
  if (!args) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(args);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const rec = parsed as Record<string, unknown>;
  if (typeof rec.path === "string") {
    let line: number | undefined;
    // read_file supports `range` like "50-100" — open at the first line.
    if (typeof rec.range === "string") {
      const first = rec.range.split("-")[0];
      const n = Number.parseInt(first ?? "", 10);
      if (Number.isFinite(n) && n > 0) line = n;
    }
    if (line === undefined && typeof rec.line === "number" && rec.line > 0) line = rec.line;
    return { path: rec.path, line };
  }
  // multi_edit: use the first edit's path
  if (Array.isArray(rec.edits) && rec.edits.length > 0) {
    const first = rec.edits[0] as Record<string, unknown> | undefined;
    if (first && typeof first.path === "string") return { path: first.path };
  }
  // move_file / copy_file: open the source
  if (typeof rec.source === "string" && rec.source) return { path: rec.source };
  return null;
}

/** Always-visible "show in file explorer" action rendered in the card header, next to the collapse toggle. */
function OpenFileButton({ path, label }: { path: string; label: string }) {
  useLang();
  const ws = useContext(WorkspaceContext);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const abs = resolveAgainstWorkspace(path, ws.dir);
  return (
    <>
      <button
        type="button"
        className="head-action"
        title={label}
        onClick={() => void revealInExplorer(abs, ws.dir)}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setMenu({ x: e.clientX, y: e.clientY });
        }}
      >
        <I.link size={12} />
        <span>{label}</span>
      </button>
      {menu ? <FileMenu anchor={menu} abs={abs} onClose={() => setMenu(null)} /> : null}
    </>
  );
}

export function Card({
  tone = "default",
  icon,
  kind,
  name,
  meta,
  defaultOpen = true,
  compact = false,
  children,
  headRight,
}: {
  tone?: Tone;
  icon: ReactNode;
  kind: string;
  name?: ReactNode;
  meta?: ReactNode;
  defaultOpen?: boolean;
  /** Slimmer header — used for thinking / tool-call process cards so they
   *  read as background detail rather than primary content. */
  compact?: boolean;
  children: ReactNode;
  headRight?: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className={compact ? "card is-compact" : "card"} data-tone={tone} data-open={open}>
      <div className="card-head-row">
        <button
          type="button"
          className="card-head"
          onClick={() => setOpen((v) => !v)}
          style={{
            flex: 1,
            minWidth: 0,
            background: "none",
            border: "none",
            textAlign: "left",
            font: "inherit",
            color: "inherit",
          }}
        >
          <span className="ico">{icon}</span>
          <span className="kind">{kind}</span>
          {name ? <span className="name">{name}</span> : null}
          <span className="grow" />
          {meta ? <span className="meta">{meta}</span> : null}
          <span className="chev">
            <I.chev size={12} />
          </span>
        </button>
        {headRight}
      </div>
      {open ? <div className="card-body">{children}</div> : null}
    </div>
  );
}

// ---- Plan ----

export type PlanItem = {
  id: string | number;
  status: "todo" | "active" | "done" | "failed" | "blocked" | "skipped";
  text: string;
  tool?: string;
  note?: string;
};

function derivePlanBadge(items: PlanItem[]): {
  state: "running" | "done" | "failed" | "waiting" | "blocked";
  label: string;
} {
  if (items.some((x) => x.status === "failed"))
    return { state: "failed", label: t("planBadge.failed") };
  if (items.some((x) => x.status === "blocked"))
    return { state: "blocked", label: t("planBadge.blocked") };
  if (items.some((x) => x.status === "active"))
    return { state: "running", label: t("planBadge.running") };
  if (items.length > 0 && items.every((x) => x.status === "done"))
    return { state: "done", label: t("planBadge.done") };
  return { state: "waiting", label: t("planBadge.pending") };
}

function StatusIcon({
  state,
  label,
}: { state: "running" | "done" | "failed" | "waiting" | "blocked"; label: string }) {
  switch (state) {
    case "running":
      return <span className="spin-meta" role="img" aria-label={label} title={label} />;
    case "done":
      return <I.check size={10} style={{ color: "var(--success)" }} aria-label={label} />;
    case "failed":
      return <I.x size={10} style={{ color: "var(--danger)" }} aria-label={label} />;
    case "waiting":
      return <span className="status-dot warn" role="img" aria-label={label} title={label} />;
    case "blocked":
      return <I.slash size={10} style={{ color: "var(--warning)" }} aria-label={label} />;
  }
}

export function PlanCardView({ items, title }: { items: PlanItem[]; title?: string }) {
  useLang();
  const resolvedTitle = title ?? t("cards.planDefaultTitle");
  const done = items.filter((x) => x.status === "done").length;
  const badge = derivePlanBadge(items);
  return (
    <Card
      tone="accent"
      icon={<I.list size={12} />}
      kind="plan"
      name={resolvedTitle}
      meta={
        <>
          <span>
            {done}/{items.length}
          </span>
          <StatusIcon state={badge.state} label={badge.label} />
          <span className="meta-label">{badge.label}</span>
        </>
      }
    >
      <ul className="plan-list" style={{ listStyle: "none", margin: 0, padding: "8px 12px 12px" }}>
        {items.map((it) => (
          <li key={it.id} className="plan-item" data-status={it.status}>
            <span className="ck">{it.status === "done" ? <I.check size={12} /> : null}</span>
            <div>
              <div className="text">{it.text}</div>
              {it.tool || it.note ? (
                <div className="sub">
                  {it.tool ? <span className="tool">{it.tool}</span> : null}
                  {it.note ? <span>{it.note}</span> : null}
                </div>
              ) : null}
            </div>
            <span className="stat">
              {it.status === "active" ? <span className="spin" /> : null}
            </span>
          </li>
        ))}
      </ul>
    </Card>
  );
}

// ---- Reasoning ----

/** Render `code` and **bold** fragments from model reasoning as React nodes
 *  (no dangerouslySetInnerHTML — the text is model output, not trusted HTML). */
function inlineReasoningNodes(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /`([^`]+)`|\*\*([^*]+)\*\*/g;
  let last = 0;
  let n = 0;
  for (const m of text.matchAll(re)) {
    if (m.index! > last) out.push(text.slice(last, m.index!));
    out.push(
      m[1] !== undefined ? (
        <span className="hl" key={n}>
          {m[1]}
        </span>
      ) : (
        <strong key={n}>{m[2]}</strong>
      ),
    );
    n += 1;
    last = m.index! + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function ReasoningCard({
  text,
  streaming,
  tokens,
  elapsed,
  model,
}: {
  text: string;
  streaming: boolean;
  tokens?: number;
  elapsed?: string;
  model?: string;
}) {
  useLang();
  return (
    <Card
      tone="violet"
      icon={<I.brain size={12} />}
      kind="reasoning"
      name={t("cards.reasoningName")}
      meta={
        <>
          {elapsed || tokens ? (
            <span>
              {elapsed ?? ""}
              {elapsed && tokens ? " · " : ""}
              {tokens ? `${tokens.toLocaleString()} t` : ""}
            </span>
          ) : null}
          {streaming ? (
            <StatusIcon state="running" label={t("cards.streaming")} />
          ) : (
            <StatusIcon state="done" label={t("cards.reasoningComplete")} />
          )}
        </>
      }
      defaultOpen={streaming}
      compact
    >
      <div className="reason">
        <div className="stream">
          {text.split(/\n\n+/).map((para, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: static paragraph snapshot, no reordering
            <p key={i}>{inlineReasoningNodes(para)}</p>
          ))}
        </div>
        {model || tokens !== undefined ? (
          <div className="meta">
            {model ? (
              <span>
                <span className="k">{t("settings.model")}</span> {model}
              </span>
            ) : null}
            {tokens !== undefined ? (
              <span>
                <span className="k">{t("statusbar.tokens")}</span> {tokens.toLocaleString()}
              </span>
            ) : null}
          </div>
        ) : null}
      </div>
    </Card>
  );
}

// ---- Shell ----

export function ShellCard({
  command,
  output,
  state,
  durationMs,
  onApprove,
  onReject,
  onAlwaysAllow,
  onStop,
}: {
  command: string;
  output?: string;
  state: "await" | "running" | "done" | "failed";
  durationMs?: number;
  onApprove?: () => void;
  onReject?: () => void;
  onAlwaysAllow?: () => void;
  onStop?: () => void;
}) {
  useLang();
  const tone: Tone = state === "failed" ? "danger" : state === "done" ? "success" : "warning";
  return (
    <Card
      tone={tone}
      icon={<I.terminal size={12} />}
      kind="shell"
      name="shell"
      compact
      defaultOpen={state !== "done"}
      meta={
        <>
          {state === "await" ? (
            <StatusIcon state="waiting" label={t("cards.shellAwaiting")} />
          ) : state === "running" ? (
            <StatusIcon state="running" label={t("cards.shellRunning")} />
          ) : state === "failed" ? (
            <StatusIcon state="failed" label={t("cards.failed")} />
          ) : (
            <StatusIcon state="done" label={t("cards.done")} />
          )}
          {(state === "done" || state === "failed") && durationMs ? (
            <span className="meta-dur">{(durationMs / 1000).toFixed(2)}s</span>
          ) : null}
        </>
      }
    >
      <div className="shell">
        <div className="cmd">
          <span className="prompt">$</span>
          <span className="text">{command}</span>
        </div>
        {output ? (
          <pre className="out">
            {output.split("\n").map((ln, i) => {
              if (ln.startsWith(" ✓") || ln.startsWith("✓"))
                return (
                  // biome-ignore lint/suspicious/noArrayIndexKey: static output snapshot
                  <div key={i}>
                    <span className="ok">{ln}</span>
                  </div>
                );
              if (ln.startsWith(" ✗") || ln.startsWith("✗") || /error/i.test(ln))
                return (
                  // biome-ignore lint/suspicious/noArrayIndexKey: static output snapshot
                  <div key={i}>
                    <span className="err">{ln}</span>
                  </div>
                );
              // biome-ignore lint/suspicious/noArrayIndexKey: static output snapshot
              return <div key={i}>{ln}</div>;
            })}
          </pre>
        ) : null}
        {state === "await" && onApprove ? (
          <div className="approve-row">
            <div className="why">
              <b>{t("cards.shellAwaiting")}</b> — {t("cards.shellExecuteHint")}
            </div>
            <div className="actions">
              {onAlwaysAllow ? (
                <button type="button" className="btn ghost" onClick={onAlwaysAllow}>
                  {t("cards.shellAlwaysAllow")}
                </button>
              ) : null}
              {onReject ? (
                <button type="button" className="btn" onClick={onReject}>
                  {t("cards.shellReject")} <Shortcut keys={["mod", "."]} />
                </button>
              ) : null}
              <button type="button" className="btn primary" onClick={onApprove}>
                {t("cards.shellRun")} <Shortcut keys={["mod", "enter"]} />
              </button>
            </div>
          </div>
        ) : null}
        {state === "running" && onStop ? (
          <div className="approve-row">
            <div className="why">
              {t("cards.shellRunning")} — {t("cards.shellStopHint")}
            </div>
            <div className="actions">
              <button type="button" className="btn danger" onClick={onStop}>
                {t("cards.shellStop")}
              </button>
            </div>
          </div>
        ) : null}
      </div>
    </Card>
  );
}

// ---- Compaction ----

export function CompactionCard({
  state = "done",
  reason,
  compactionKind,
  aggressive,
  beforeMessages,
  afterMessages,
  summaryChars,
  prunedFiles,
  prunedTokens,
  droppedFiles,
  summary,
  warn,
  error,
}: {
  /** running → spinner; done → folded result; failed → error; idle → nothing to fold. */
  state?: "running" | "done" | "failed" | "idle";
  reason?: "user" | "auto-context-pressure";
  /** "force-summary" = context-guard / stuck trim + summarize in place (log not folded). */
  compactionKind?: "fold" | "force-summary";
  aggressive?: boolean;
  beforeMessages?: number;
  afterMessages?: number;
  summaryChars?: number;
  /** Unique file paths whose read results were pruned by the fold's prune step. */
  prunedFiles?: number;
  /** Tokens saved by the prune step. */
  prunedTokens?: number;
  /** File paths the fold's triage step classified as no longer relevant. */
  droppedFiles?: string[];
  summary?: string;
  /** Advisory warning on a successful fold — e.g. file triage failed, nothing dropped. */
  warn?: string;
  error?: string;
}) {
  useLang();
  const running = state === "running";
  const failed = state === "failed";
  const idle = state === "idle";
  const name =
    !running && compactionKind === "force-summary"
      ? t("cards.compactionForcedName")
      : running
        ? t("cards.compactionRunningName")
        : t("cards.compactionName");
  const meta = (
    <>
      {running ? (
        <StatusIcon state="running" label={t("cards.compactionRunning")} />
      ) : failed ? (
        <StatusIcon state="failed" label={t("cards.failed")} />
      ) : idle ? (
        <StatusIcon state="waiting" label={t("cards.compactionNothingToFold")} />
      ) : (
        <StatusIcon state="done" label={t("cards.done")} />
      )}
      {!running && !idle && beforeMessages !== undefined ? (
        <span className="meta-dur">
          {t("cards.compactionDoneMeta", {
            before: beforeMessages.toLocaleString(),
            after: (afterMessages ?? 0).toLocaleString(),
            chars: (summaryChars ?? 0).toLocaleString(),
          })}
          {prunedFiles ? (
            <>
              {" · "}
              {t("cards.compactionPruned", {
                files: prunedFiles.toLocaleString(),
                tokens: (prunedTokens ?? 0).toLocaleString(),
              })}
            </>
          ) : null}
          {droppedFiles?.length ? (
            <>
              {" · "}
              {t("cards.compactionDropped", { count: droppedFiles.length.toLocaleString() })}
            </>
          ) : null}
        </span>
      ) : null}
      {!running && reason === "user" ? (
        <span className="meta-label">{t("cards.compactionManual")}</span>
      ) : null}
    </>
  );
  const body = running ? (
    <div className="compaction-body">
      {t("cards.compactionRunningBody")}
      {aggressive ? ` ${t("cards.compactionAggressive")}` : ""}
    </div>
  ) : failed ? (
    <div className="compaction-body">
      {t("cards.compactionFailedBody")}
      {error ? ` — ${error}` : ""}
    </div>
  ) : idle ? (
    <div className="compaction-body">{t("cards.compactionNothingToFold")}</div>
  ) : summary ? (
    <div className="compaction-body">
      <Markdown source={summary} />
      {warn ? <div className="compaction-warn">{warn}</div> : null}
    </div>
  ) : warn ? (
    <div className="compaction-body">{warn}</div>
  ) : null;
  return (
    <Card
      tone={failed ? "danger" : "default"}
      icon={<I.archive size={12} />}
      kind="compaction"
      name={name}
      meta={meta}
      defaultOpen={running}
      compact
    >
      {body}
    </Card>
  );
}

// ---- Generic Tool ----

export function ToolCard({
  name,
  args,
  result,
  ok,
  durationMs,
}: {
  name: string;
  args?: string;
  result?: string;
  ok?: boolean;
  durationMs?: number;
}) {
  useLang();
  const fileRef = useMemo(() => extractToolFileRef(args), [args]);
  const running = result === undefined;
  const tone: Tone = running ? "default" : ok === false ? "danger" : "success";
  // Web tool results (web_search, web_fetch, …) carry the engine that
  // served the call (resolved from config at call time) as an `engine:`
  // line — surface it in the header. No per-tool special-casing.
  const engine = useMemo(() => {
    if (!result) return undefined;
    const m = /^engine:\s*(\S+)/m.exec(result);
    return m?.[1];
  }, [result]);
  return (
    <Card
      tone={tone}
      icon={<I.wrench size={12} />}
      kind="tool"
      name={name}
      defaultOpen={false}
      compact
      meta={
        <>
          {running ? (
            <StatusIcon state="running" label={t("cards.running")} />
          ) : ok === false ? (
            <StatusIcon state="failed" label={t("cards.error")} />
          ) : (
            <StatusIcon state="done" label={t("cards.done")} />
          )}
          {!running && durationMs !== undefined ? (
            <span className="meta-dur">{durationMs} ms</span>
          ) : null}
          {engine ? <span className="pill-tag ok">{engine}</span> : null}
        </>
      }
      headRight={fileRef ? <OpenFileButton path={fileRef.path} label={fileRef.path} /> : undefined}
    >
      <div className="tool-call">
        {args ? (
          <div className="row">
            <span className="k">args</span>
            <span className="v">
              <span className="str">{args.length > 600 ? `${args.slice(0, 600)}…` : args}</span>
            </span>
          </div>
        ) : null}
        {result !== undefined ? (
          <div className="row">
            <span className="k">{ok === false ? t("cards.error") : t("cards.result")}</span>
            <span className="v">
              <span className={ok === false ? "num" : "str"}>
                {result.length > 1200 ? `${result.slice(0, 1200)}…` : result}
              </span>
            </span>
          </div>
        ) : null}
      </div>
    </Card>
  );
}

// ---- Diff ----

export type DiffLine =
  | { t: "hunk"; s: string }
  | { t: "ctx"; l?: number; r?: number; s: string }
  | { t: "add"; r: number; s: string }
  | { t: "rm"; l: number; s: string };

export function parseEditResult(text: string): { filename: string; lines: DiffLine[] }[] {
  const files: { filename: string; lines: DiffLine[] }[] = [];
  const lines = text.split("\n");

  let currentFilename = "";
  let currentLines: DiffLine[] = [];
  let hunkStartLeft = 0;
  let hunkStartRight = 0;
  let leftLine = 0;
  let rightLine = 0;

  const flush = () => {
    if (currentLines.length > 0) {
      files.push({ filename: currentFilename, lines: currentLines });
    }
    currentLines = [];
    hunkStartLeft = 0;
    hunkStartRight = 0;
    leftLine = 0;
    rightLine = 0;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;

    if (line.startsWith("edited ") || line.startsWith("multi_edit:")) {
      const m = line.match(/^edited\s+(.+?)\s+\(/);
      if (m) currentFilename = m[1]!;
      continue;
    }

    if (line.startsWith("# ")) {
      flush();
      currentFilename = line.slice(2);
      continue;
    }

    const hunkMatch = line.match(/^@@\s+-(\d+),(\d+)\s+\+(\d+),(\d+)\s+@@/);
    if (hunkMatch) {
      hunkStartLeft = Number(hunkMatch[1]!);
      hunkStartRight = Number(hunkMatch[3]!);
      leftLine = hunkStartLeft;
      rightLine = hunkStartRight;
      currentLines.push({ t: "hunk", s: line });
      continue;
    }

    if (line.startsWith("+") && !line.startsWith("+++")) {
      currentLines.push({ t: "add", r: rightLine, s: line.slice(1) });
      rightLine++;
    } else if (line.startsWith("-") && !line.startsWith("---")) {
      currentLines.push({ t: "rm", l: leftLine, s: line.slice(1) });
      leftLine++;
    } else if (line.startsWith(" ")) {
      currentLines.push({ t: "ctx", l: leftLine, r: rightLine, s: line.slice(1) });
      leftLine++;
      rightLine++;
    }
  }

  flush();
  return files;
}

export function DiffCard({
  filename,
  lines,
  applied,
  onApply,
  onDiscard,
}: {
  filename: string;
  lines: DiffLine[];
  applied?: boolean;
  onApply?: () => void;
  onDiscard?: () => void;
}) {
  useLang();
  const adds = lines.filter((x) => x.t === "add").length;
  const rms = lines.filter((x) => x.t === "rm").length;
  return (
    <Card
      tone={applied ? "success" : "accent"}
      icon={<I.diff size={12} />}
      kind="edit"
      name={filename}
      meta={
        <>
          <span style={{ color: "var(--success)" }}>+{adds}</span>
          <span style={{ color: "var(--danger)" }}>−{rms}</span>
          {applied ? (
            <StatusIcon state="done" label={t("cards.applied")} />
          ) : (
            <StatusIcon state="waiting" label={t("cards.diffAwaiting")} />
          )}
        </>
      }
      headRight={<OpenFileButton path={filename} label={t("cards.showInExplorer")} />}
    >
      <div className="diff">
        <div className="lines">
          {lines.map((ln, i) => {
            if (ln.t === "hunk")
              return (
                // biome-ignore lint/suspicious/noArrayIndexKey: static diff snapshot
                <div key={i} className="ln hunk">
                  <span className="code">{ln.s}</span>
                </div>
              );
            const cls = ln.t === "add" ? "add" : ln.t === "rm" ? "rm" : "";
            const l = ln.t === "ctx" ? ln.l : ln.t === "rm" ? ln.l : undefined;
            const r = ln.t === "ctx" ? ln.r : ln.t === "add" ? ln.r : undefined;
            return (
              // biome-ignore lint/suspicious/noArrayIndexKey: static diff snapshot
              <div key={i} className={`ln ${cls}`}>
                <span className="num">{l ?? ""}</span>
                <span className="num">{r ?? ""}</span>
                <span className="code">
                  {ln.t === "add" ? "+ " : ln.t === "rm" ? "− " : "  "}
                  {ln.s}
                </span>
              </div>
            );
          })}
        </div>
        {!applied && (onApply || onDiscard) ? (
          <div className="approve-row">
            <div className="why">
              <b>{t("cards.diffApplyChanges")}</b> · +{adds} / −{rms}
            </div>
            <div className="actions">
              {onDiscard ? (
                <button type="button" className="btn" onClick={onDiscard}>
                  {t("cards.diffDiscard")}
                </button>
              ) : null}
              {onApply ? (
                <button type="button" className="btn primary" onClick={onApply}>
                  {t("cards.diffApply")} <Shortcut keys={["mod", "enter"]} />
                </button>
              ) : null}
            </div>
          </div>
        ) : null}
      </div>
    </Card>
  );
}

// ---- Timeline notices ----

export type NoticeSeverity = "info" | "success" | "warning" | "error";

export function noticeName(severity: NoticeSeverity): string {
  switch (severity) {
    case "success":
      return t("cards.successName");
    case "warning":
      return t("cards.warningName");
    case "error":
      return t("cards.errorName");
    default:
      return t("cards.noticeName");
  }
}

export function NoticeCard({
  text,
  severity = "info",
  name,
}: {
  text: string;
  severity?: NoticeSeverity;
  name?: string;
}) {
  useLang();
  const tone: Tone =
    severity === "error"
      ? "danger"
      : severity === "warning"
        ? "warning"
        : severity === "success"
          ? "success"
          : "accent";
  const icon =
    severity === "success" ? (
      <I.check size={12} />
    ) : severity === "info" ? (
      <I.zap size={12} />
    ) : (
      <I.warning size={12} />
    );
  return (
    <Card
      tone={tone}
      icon={icon}
      kind={severity}
      name={name ?? noticeName(severity)}
      defaultOpen
      compact
    >
      <div className="notice-body" data-severity={severity}>
        {text}
      </div>
    </Card>
  );
}

export function WarningCard({
  text,
  severity = "high",
}: {
  text: string;
  severity?: "low" | "high";
}) {
  const isDegeneration = /degenerat|repetiti/i.test(text);
  return (
    <NoticeCard
      text={text}
      severity={severity === "low" ? "info" : "warning"}
      name={isDegeneration ? t("cards.degenerationName") : undefined}
    />
  );
}

export const SUBAGENT_TOOLS = new Set([
  "explore",
  "research",
  "review",
  "security_review",
  "security-review",
  "spawn_subagent",
]);

export function isSubagentTool(name: string, args?: string): boolean {
  if (SUBAGENT_TOOLS.has(name)) return true;
  if (name === "run_skill" && args) {
    try {
      const parsed = JSON.parse(args);
      if (typeof parsed.name === "string" && SUBAGENT_TOOLS.has(parsed.name)) return true;
    } catch {
      // ignore JSON parse error
    }
  }
  return false;
}

export function extractSubagentDetails(
  name: string,
  args?: string,
): { task: string; skillName: string; model?: string } {
  let task = "";
  let skillName = name;
  let model: string | undefined;
  if (args) {
    try {
      const parsed = JSON.parse(args);
      if (typeof parsed.task === "string") task = parsed.task;
      else if (typeof parsed.arguments === "string") task = parsed.arguments;
      else if (typeof parsed.query === "string") task = parsed.query;
      else task = args;

      if (name === "run_skill" && typeof parsed.name === "string") {
        skillName = parsed.name;
      }
      if (typeof parsed.model === "string") {
        model = parsed.model;
      }
    } catch {
      task = args;
    }
  }
  return { task: task || name, skillName, model };
}

export type SubagentResultMeta = {
  costUsd?: number;
  billingKind?: "usd" | "quota" | "none";
  quotaUsedPct?: number;
  model?: string;
  elapsedMs?: number;
  turns?: number;
};

/** Recover model / cost / billing from the subagent's persisted result envelope. The
 *  live `subagent.progress` stream carries these on `subagentRuns`, but after a session
 *  reload `subagentRuns` is not persisted — the result JSON is the reliable source. */
export function extractSubagentResultMeta(result?: string): SubagentResultMeta {
  if (!result) return {};
  try {
    const parsed = JSON.parse(result) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object") return {};
    const out: SubagentResultMeta = {};
    if (typeof parsed.cost_usd === "number") out.costUsd = parsed.cost_usd;
    if (typeof parsed.model === "string") out.model = parsed.model;
    if (
      parsed.billing_kind === "usd" ||
      parsed.billing_kind === "quota" ||
      parsed.billing_kind === "none"
    ) {
      out.billingKind = parsed.billing_kind;
    }
    if (typeof parsed.quota_used_pct === "number") out.quotaUsedPct = parsed.quota_used_pct;
    if (typeof parsed.elapsed_ms === "number") out.elapsedMs = parsed.elapsed_ms;
    if (typeof parsed.turns === "number") out.turns = parsed.turns;
    return out;
  } catch {
    return {};
  }
}

function SubagentActivityRows({ run }: { run: import("../App").SubagentRunProgress }) {
  const rowsToShow =
    run.recentRows && run.recentRows.length > 0
      ? run.recentRows.slice(-3)
      : [
          {
            id: "init",
            kind: "process" as const,
            text: `Starting ${run.skillName ?? "subagent"}...`,
          },
        ];

  return (
    <div className="sub-activity" aria-label="Subagent activity">
      {rowsToShow.map((row) => (
        <div className="sub-activity-row" key={row.id}>
          <span className={`sub-activity-dot ${row.kind}`} />
          <span className="sub-activity-tag">{row.kind}</span>
          <span className="sub-activity-text" title={row.text}>
            {row.text}
          </span>
        </div>
      ))}
    </div>
  );
}

export function SubagentCard({
  name,
  runs,
  result,
  ok,
  durationMs,
}: {
  name: string;
  runs: import("../App").SubagentRunProgress[];
  args?: string;
  result?: string;
  ok?: boolean;
  durationMs?: number;
}) {
  useLang();
  const done = runs.filter((run) => run.status === "done").length;
  const models = [...new Set(runs.flatMap((run) => (run.model ? [run.model] : [])))];
  const contexts = runs.flatMap((run) =>
    run.contextTokens !== undefined ? [tokenLabel(run.contextTokens)] : [],
  );
  const status = runs.some((run) => run.status === "running")
    ? "running"
    : runs.some((run) => run.status === "failed") || ok === false
      ? "failed"
      : "done";
  const settled = status !== "running";
  // Token-priced runs: sum the real USD cost once every run has settled.
  const settledCostUsd =
    settled && runs.every((run) => run.costUsd !== undefined)
      ? runs.reduce((total, run) => total + (run.costUsd ?? 0), 0)
      : null;
  // Plan-based runs: sum the consumed provider-window % for runs that produced
  // a measurable quota delta. A `$` figure would be invented for these models.
  const quotaRuns = runs.filter(
    (run) => run.billingKind === "quota" && run.quotaUsedPct !== undefined,
  );
  const settledQuotaPct =
    settled && quotaRuns.length > 0
      ? quotaRuns.reduce((total, run) => total + (run.quotaUsedPct ?? 0), 0)
      : null;
  const billingMeta =
    settledQuotaPct !== null
      ? `${settledQuotaPct.toFixed(2)}%`
      : settledCostUsd !== null && settledCostUsd > 0
        ? `$${settledCostUsd.toFixed(4)}`
        : null;
  return (
    <Card
      tone={status === "failed" ? "danger" : "violet"}
      icon={<I.bot size={12} />}
      kind="subagent"
      name={name}
      meta={
        <>
          {models.length > 0 ? <span className="meta-model">{models.join(" + ")}</span> : null}
          {contexts.length > 0 ? (
            <span className="meta-context">ctx {contexts.join(" / ")}</span>
          ) : null}
          {billingMeta ? <span className="meta-cost">{billingMeta}</span> : null}
          <span>
            {done} / {runs.length} {t("cards.subagentDoneProgress")}
          </span>
          {status === "done" ? (
            <StatusIcon state="done" label={t("cards.subagentDone")} />
          ) : status === "failed" ? (
            <StatusIcon state="failed" label={t("cards.subagentFailed")} />
          ) : (
            <StatusIcon state="running" label={t("cards.subagentRunning")} />
          )}
          {settled && durationMs !== undefined ? (
            <span className="meta-dur">
              {durationMs >= 1000 ? `${(durationMs / 1000).toFixed(1)}s` : `${durationMs} ms`}
            </span>
          ) : null}
        </>
      }
    >
      <div className="sub-card">
        {runs.map((run) => (
          <div className="sub-row" key={run.runId}>
            <span className="av">AI</span>
            <div className="what">
              <div>{run.task}</div>
              <div className="role">
                {run.skillName ?? "subagent"}
                {run.model ? ` · ${run.model}` : ""}
                {run.phase ? ` · ${run.phase}` : ""}
                {run.elapsedMs !== undefined ? ` · ${(run.elapsedMs / 1000).toFixed(1)}s` : ""}
                {run.iter !== undefined ? ` · ${run.iter} tools` : ""}
                {run.maxToolIters !== undefined ? ` / ${run.maxToolIters}` : ""}
                {run.maxElapsedMs !== undefined
                  ? ` · ${(run.maxElapsedMs / 1000).toFixed(0)}s limit`
                  : ""}
              </div>
              {run.status === "running" ? (
                <SubagentActivityRows run={run} />
              ) : (
                run.tools.map((tool) => (
                  <div className="role" key={tool.callId} title={tool.args}>
                    {tool.status === "running" ? "↳ …" : tool.status === "failed" ? "↳ ✕" : "↳ ✓"}{" "}
                    {tool.name}
                    {tool.args ? ` ${tool.args}` : ""}
                  </div>
                ))
              )}
              <div className="role">
                {run.toolReadChars !== undefined
                  ? `${run.toolReadChars.toLocaleString()} read chars`
                  : ""}
                {run.outputChars !== undefined
                  ? ` · ${run.outputChars.toLocaleString()} output chars`
                  : ""}
                {run.reasoningChars !== undefined
                  ? ` · ${run.reasoningChars.toLocaleString()} reasoning chars`
                  : ""}
                {run.turns !== undefined ? ` · ${run.turns} turns` : ""}
                {run.costUsd !== undefined ? ` · $${run.costUsd.toFixed(4)}` : ""}
              </div>
              {run.budgetExhausted ? (
                <div className="role">
                  Stopped at {run.budgetExhausted === "elapsed" ? "time" : "tool-call"} budget
                </div>
              ) : null}
              {run.error ? <div className="role">{run.error}</div> : null}
            </div>
            <span className="prog">
              {run.status === "done" ? (
                <I.check size={12} style={{ color: "var(--success)" }} />
              ) : run.status === "failed" ? (
                <I.x size={12} style={{ color: "var(--danger)" }} />
              ) : (
                <span className="spin" />
              )}
            </span>
          </div>
        ))}
        {result ? (
          <div
            className="subagent-result"
            style={{
              marginTop: "8px",
              paddingTop: "8px",
              borderTop: "1px solid var(--border)",
            }}
          >
            <Markdown source={result} />
          </div>
        ) : null}
      </div>
    </Card>
  );
}

// ---- Memory rows ----

export type MemRow = { scope: string; txt: string };

export function MemoryCard({ rows }: { rows: MemRow[] }) {
  useLang();
  return (
    <Card
      tone="violet"
      icon={<I.bookmark size={12} />}
      kind="memory"
      name={t("cards.memoryName")}
      meta={
        <span>
          + {rows.length} {t("cards.memoryCountSuffix")}
        </span>
      }
    >
      <div className="mem">
        {rows.map((m, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: memory rows are a static snapshot (texts can repeat)
          <div className="mem-row" key={i}>
            <span className="scope">{m.scope}</span>
            <span className="txt">{m.txt}</span>
          </div>
        ))}
      </div>
    </Card>
  );
}

// ---- Image attachment ----

export function AttachCard({
  filename,
  meta,
  preview,
}: {
  filename: string;
  meta: string;
  preview?: string;
}) {
  useLang();
  return (
    <Card
      tone="default"
      icon={<I.image size={12} />}
      kind="image"
      name={filename}
      meta={<span>{meta}</span>}
    >
      <div className="attach-card">
        <div className="ph">{preview ?? "PNG"}</div>
        <div className="info">
          <div className="n">{filename}</div>
          <div className="m">{meta}</div>
        </div>
        <button type="button" className="btn ghost">
          <I.download size={12} />
        </button>
      </div>
    </Card>
  );
}

// ---- Metric strip (inline) ----

export function MetricStrip({
  cacheHit,
  promptTokens,
  outputTokens,
  costLabel,
  elapsed,
}: {
  cacheHit?: number;
  promptTokens?: number;
  outputTokens?: number;
  costLabel?: string;
  elapsed?: string;
}) {
  return (
    <div className="metric-strip">
      {cacheHit !== undefined ? (
        <span className="item">
          <I.zap size={11} style={{ color: "var(--accent)" }} />
          <span>{t("cards.cacheHit")}</span>
          <span className="v acc">{cacheHit}%</span>
        </span>
      ) : null}
      {promptTokens !== undefined ? (
        <span className="item">
          <span>{t("cards.prompt")}</span>
          <span className="v">{promptTokens.toLocaleString()} t</span>
        </span>
      ) : null}
      {outputTokens !== undefined ? (
        <span className="item">
          <span>{t("cards.output")}</span>
          <span className="v">{outputTokens.toLocaleString()} t</span>
        </span>
      ) : null}
      {costLabel ? (
        <span className="item">
          <I.coin size={11} />
          <span>{t("cards.cost")}</span>
          <span className="v ok">{costLabel}</span>
        </span>
      ) : null}
      {elapsed ? (
        <span className="item">
          <span>{t("cards.elapsed")}</span>
          <span className="v">{elapsed}</span>
        </span>
      ) : null}
    </div>
  );
}

// ---- Checkpoint marker (inline) ----

export function Checkpoint({
  hash,
  label,
  onRewind,
}: {
  hash: string;
  label: string;
  onRewind?: () => void;
}) {
  useLang();
  return (
    <div className="checkpoint">
      <I.history size={12} />
      <span className="hash">{hash}</span>
      <span>·</span>
      <span>{label}</span>
      {onRewind ? (
        <button type="button" onClick={onRewind}>
          {t("cards.checkpointRewind")}
        </button>
      ) : null}
    </div>
  );
}

// ---- Plain text block (assistant content via markdown) ----

export const AssistantText = memo(function AssistantText({ text }: { text: string }) {
  return (
    <div className="msg-text">
      <Markdown source={text} />
    </div>
  );
});
