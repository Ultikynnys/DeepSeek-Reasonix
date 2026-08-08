import { useEffect, useRef } from "react";
import { t, useLang } from "../i18n";
import { I } from "../icons";

export function fmtElapsed(ms: number): string {
  const s = ms / 1000;
  return s < 10 ? `${s.toFixed(1)}s` : `${Math.floor(s)}s`;
}

/** A span that displays an auto-updating elapsed-time counter using direct
 *  DOM mutation. This avoids React re-renders on every tick — the timer
 *  update never cascades through the component tree. */
export function TimerSpan({
  active,
  startAt,
  className,
  format,
}: {
  active: boolean;
  startAt?: number;
  className?: string;
  format?: (ms: number) => string;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const start = useRef<number | null>(null);
  const fmt = format ?? fmtElapsed;

  useEffect(() => {
    if (!active) {
      if (ref.current) ref.current.textContent = "";
      start.current = null;
      return;
    }
    start.current = startAt ?? performance.now();
    const id = setInterval(() => {
      if (start.current !== null && ref.current) {
        ref.current.textContent = fmt(performance.now() - start.current);
      }
    }, 250);
    return () => clearInterval(id);
  }, [active, startAt, fmt]);

  return <span ref={ref} className={className} />;
}

export function ThinkingPill({
  phase = "thinking",
  label,
}: {
  phase?: "queued" | "thinking" | "tool";
  label: string;
}) {
  const color =
    phase === "queued" ? "var(--muted)" : phase === "tool" ? "var(--warning)" : "var(--accent)";
  return (
    <div className="thinking">
      <span className="dots" style={{ color }}>
        <span style={{ background: color }} />
        <span style={{ background: color }} />
        <span style={{ background: color }} />
      </span>
      <span className="label">
        <span className="sh">{label}</span>
      </span>
      <TimerSpan active className="timer" />
    </div>
  );
}

export function LiveReasoning({ lines }: { lines: string[] }) {
  useLang();
  return (
    <div className="live-reason">
      <div className="head">
        <span className="dot" /> {t("live.reasoning")}
      </div>
      {lines.map((line, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: reasoning stream is append-only; order never changes
        <div key={i}>
          {line}
          {i === lines.length - 1 ? <span className="stream-caret" /> : null}
        </div>
      ))}
    </div>
  );
}

export function ToolRunningCard({
  kind = "tool",
  name,
  logLines,
}: {
  kind?: "shell" | "fetch" | "search" | "tool";
  name: string;
  logLines?: { text: string; tone?: "ok" | "dim" }[];
}) {
  useLang();
  const ic =
    kind === "shell" ? (
      <I.terminal size={12} />
    ) : kind === "fetch" ? (
      <I.globe size={12} />
    ) : kind === "search" ? (
      <I.search size={12} />
    ) : (
      <I.wrench size={12} />
    );
  return (
    <div className="skel-card">
      <div className="h">
        <span className="ico">{ic}</span>
        <span className="kind">{kind}</span>
        <span style={{ color: "var(--fg)", fontWeight: 500 }}>{name}</span>
        <span className="grow" />
        <span
          className="spin-meta"
          role="img"
          aria-label={t("live.running")}
          title={t("live.running")}
        />
        <TimerSpan active className="timer" />
      </div>
      {logLines && logLines.length > 0 ? (
        <div className="live-log">
          {logLines.map((ln, i) => (
            <div
              // biome-ignore lint/suspicious/noArrayIndexKey: render-time snapshot; animation stagger needs the index anyway
              key={i}
              className={`line ${ln.tone ?? ""}`}
              style={{ animationDelay: `${i * 0.25}s` }}
            >
              {ln.text}
            </div>
          ))}
        </div>
      ) : (
        <div className="body">
          <div className="skel-line w-90" />
          <div className="skel-line w-70" />
          <div className="skel-line w-60" />
        </div>
      )}
    </div>
  );
}

export function PendingUserMsg({ text }: { text: string }) {
  useLang();
  return (
    <div className="msg user">
      <div className="avatar">YOU</div>
      <div className="body">
        <div className="who">
          <span className="name">{t("live.you")}</span>
          <TimerSpan
            active
            className="time"
            format={(ms) =>
              t("live.secondsAgo", { seconds: (ms / 1000).toFixed(1) })
            }
          />
        </div>
        <div className="msg-text user-pending">{text}</div>
        <div className="user-status">
          <span className="spin" />
          <span>{t("live.deliveredWaiting")}</span>
        </div>
      </div>
    </div>
  );
}
