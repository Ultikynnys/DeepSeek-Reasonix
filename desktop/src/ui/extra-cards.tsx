import type { ReactNode } from "react";
import { t, useLang } from "../i18n";
import { I } from "../icons";

export type ApprovalTone = "ok" | "warn" | "danger" | "info" | "brand" | "ghost";

export function ApprovalCard({
  kind,
  tone = "info",
  title,
  sub,
  body,
  preview,
  meta,
  primaryLabel,
  secondaryLabel,
  tertiaryLabel,
  onPrimary,
  onSecondary,
  onTertiary,
}: {
  kind: string;
  tone?: ApprovalTone;
  title: string;
  sub?: string;
  body?: ReactNode;
  preview?: ReactNode;
  meta?: ReactNode;
  primaryLabel?: string;
  secondaryLabel?: string;
  tertiaryLabel?: string;
  onPrimary?: () => void;
  onSecondary?: () => void;
  onTertiary?: () => void;
}) {
  useLang();
  return (
    <div className="approval" data-tone={tone}>
      <div className="ap-head">
        <span className="ap-ico">
          <I.shield size={13} />
        </span>
        <div>
          <div className="ap-kind">{kind}</div>
          <div className="ap-title">{title}</div>
          {sub ? <div className="ap-sub">{sub}</div> : null}
        </div>
      </div>
      {body ? <div className="ap-body">{body}</div> : null}
      {preview ? <div className="ap-preview">{preview}</div> : null}
      <div className="ap-foot">
        {onPrimary ? (
          <button type="button" className="btn primary" onClick={onPrimary}>
            {primaryLabel ?? t("extraCards.approve")}
          </button>
        ) : null}
        {onSecondary ? (
          <button type="button" className="btn ghost" onClick={onSecondary}>
            {secondaryLabel ?? t("extraCards.reject")}
          </button>
        ) : null}
        {onTertiary && tertiaryLabel ? (
          <button type="button" className="btn ghost" onClick={onTertiary}>
            {tertiaryLabel}
          </button>
        ) : null}
        <span className="grow" />
        {meta ? <span className="meta">{meta}</span> : null}
      </div>
    </div>
  );
}

// ---- Task Card (multi-step execution from active plan) ----

export type TaskStepView = {
  n: string;
  state: "queued" | "running" | "done" | "failed" | "blocked" | "skipped";
  label: string;
  hint?: string;
  durationLabel?: string;
};

export function TaskCard({
  title,
  subtitle,
  steps,
}: {
  title: string;
  subtitle?: string;
  steps: TaskStepView[];
}) {
  useLang();
  const done = steps.filter((x) => x.state === "done").length;
  const pct = steps.length ? (done / steps.length) * 100 : 0;
  return (
    <div className="task-card">
      <div className="th">
        <span className="ico">
          <I.list size={13} />
        </span>
        <div>
          <div className="tt">{title}</div>
          {subtitle ? <div className="ss">{subtitle}</div> : null}
        </div>
        <span className="grow" />
        <span className="ss">
          {done}/{steps.length}
        </span>
        <div className="meter">
          <span style={{ width: `${pct}%` }} />
        </div>
      </div>
      <div className="tb">
        {steps.map((st) => (
          <div className="task-step" key={st.n} data-state={st.state}>
            <span className="nx">step.{st.n}</span>
            <span className="st" />
            <div className="l">
              {st.label}
              {st.hint ? <div className="h">{st.hint}</div> : null}
            </div>
            <span className="t">{st.durationLabel ?? "—"}</span>
          </div>
        ))}
      </div>
    </div>
  );
}


