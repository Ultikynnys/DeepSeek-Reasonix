import type { ApprovalPrompt } from "@reasonix/core-utils";
import { isCompactionSummary, stripCompactionMarker } from "@reasonix/core-utils/compaction";
import { derivePrefix } from "@reasonix/core-utils/derive-prefix";
import { Copy } from "lucide-react";
import { Fragment, memo, useState } from "react";
import type {
  ActivePlan,
  AssistantSegment,
  PendingCheckpoint,
  PendingChoice,
  PendingConfirm,
  PendingPlan,
  PendingRevision,
  SkillOrigin,
} from "../App";
import { t, useLang } from "../i18n";
import { I } from "../icons";
import type { JobInfo } from "../protocol";
import { useAutoApproveCountdown } from "./auto-countdown";
import {
  AssistantText,
  CompactionCard,
  DiffCard,
  ReasoningCard,
  ShellCard,
  SubagentCard,
  ToolCard,
  PreText,
  WarningCard,
  extractSubagentDetails,
  extractSubagentResultMeta,
  isSubagentTool,
  parseEditResult,
} from "./cards";
import { ApprovalCard, TaskCard, type TaskStepView } from "./extra-cards";

function downloadImage(dataUrl: string, mimeType: string): void {
  const ext = mimeType.split("/")[1] || "png";
  const a = document.createElement("a");
  a.href = dataUrl;
  a.download = `generated.${ext}`;
  a.click();
}

const AssistantImage = memo(function AssistantImage({
  dataUrl,
  mimeType,
}: {
  dataUrl: string;
  mimeType: string;
}) {
  useLang();
  return (
    <div className="msg-image-wrap">
      <img className="msg-image" src={dataUrl} alt="" loading="eager" />
      <button
        type="button"
        className="copy-btn"
        onClick={() => downloadImage(dataUrl, mimeType)}
        title={t("thread.downloadImage")}
      >
        <I.download size={12} />
      </button>
    </div>
  );
});

export function TurnDivider({ label }: { label: string }) {
  return (
    <div className="turn-divider">
      <span>{label}</span>
      <span className="line" />
    </div>
  );
}

export const UserMsg = memo(function UserMsg({
  text,
  images,
  time,
  skill,
}: {
  text: string;
  images?: string[];
  time?: string;
  skill?: SkillOrigin;
}) {
  useLang();
  const [copied, setCopied] = useState(false);
  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      /* ignore */
    }
  };
  return (
    <div className="msg user">
      <div className="avatar">YOU</div>
      <div className="body">
        <div className="who">
          <span className="name">{t("thread.you")}</span>
          {skill ? (
            <span className="skill-chip" title={`skill · ${skill.runAs}`}>
              <I.zap size={10} /> /{skill.name}
              {skill.runAs === "subagent" ? (
                <span className="sub">{t("thread.subagent")}</span>
              ) : null}
            </span>
          ) : null}
          {time ? <span className="time">{time}</span> : null}
        </div>
        {images && images.length > 0 ? (
          <div className="msg-images">
            {images.map((src, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: per-message image list is immutable
              <img key={i} className="msg-image" src={src} alt="" loading="eager" />
            ))}
          </div>
        ) : null}
        <PreText className="msg-text">{text}</PreText>
        <div className="msg-actions">
          <button
            type="button"
            className={`copy-btn ${copied ? "done" : ""}`}
            onClick={onCopy}
            title={t("thread.copyMessage")}
          >
            <Copy size={11} />
            {copied ? t("markdown.copied") : null}
          </button>
        </div>
      </div>
    </div>
  );
});

export const AssistantMsg = memo(function AssistantMsg({
  segments,
  pending,
  model,
  time,
  onApproveConfirm,
  onRejectConfirm,
  onAlwaysAllowConfirm,
  onStopTool,
  pendingConfirms,
  activePlan,
  jobs,
  tabId,
  onStopJob,
  isInterventionPending,
}: {
  segments: AssistantSegment[];
  pending: boolean;
  model?: string;
  time?: string;
  onApproveConfirm: (id: number) => void;
  onRejectConfirm: (id: number) => void;
  onAlwaysAllowConfirm: (id: number, prefix: string) => void;
  onStopTool: () => void;
  pendingConfirms: PendingConfirm[];
  activePlan?: ActivePlan;
  /** Live background-job snapshots (all tabs). A `run_background` shell card
   *  renders from its own job's status here so it never reads as finished while
   *  the process is still alive. */
  jobs?: JobInfo[];
  /** Id of the tab this transcript belongs to — scopes the job lookup, since
   *  per-tab registries restart their job ids at 1 (collision-prone). */
  tabId?: string;
  onStopJob?: (jobId: number) => void;
  isInterventionPending?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const content = segments
    .filter((s): s is AssistantSegment & { kind: "text" } => s.kind === "text")
    .map((s) => s.text)
    .join("\n\n");
  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(content);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      /* ignore */
    }
  };
  return (
    <div className="msg assistant">
      <div className="avatar">DS</div>
      <div className="body">
        <div className="who">
          <span className="name">Reasonix</span>
          {model ? <span className="model">{model}</span> : null}
          {time ? <span className="time">{time}</span> : null}
        </div>
        {segments.map((s, i) => {
          if (s.kind === "text") {
            if (!s.text.trim()) return null;
            if (isCompactionSummary(s.text)) {
              // biome-ignore lint/suspicious/noArrayIndexKey: streamed segments are append-only
              return <CompactionCard key={i} summary={stripCompactionMarker(s.text)} />;
            }
            // biome-ignore lint/suspicious/noArrayIndexKey: streamed segments are append-only
            return <AssistantText key={i} text={s.text} />;
          }
          if (s.kind === "reasoning") {
            return (
              <ReasoningCard
                // biome-ignore lint/suspicious/noArrayIndexKey: streamed segments are append-only
                key={i}
                text={s.text}
                streaming={pending && !isInterventionPending && i === segments.length - 1}
              />
            );
          }
          if (s.kind === "compaction") {
            return (
              <CompactionCard
                // biome-ignore lint/suspicious/noArrayIndexKey: streamed segments are append-only
                key={i}
                state={s.state}
                reason={s.reason}
                compactionKind={s.compactionKind}
                aggressive={s.aggressive}
                beforeMessages={s.beforeMessages}
                afterMessages={s.afterMessages}
                summaryChars={s.summaryChars}
                prunedFiles={s.prunedFiles}
                prunedTokens={s.prunedTokens}
                droppedFiles={s.droppedFiles}
                summary={s.summary}
                error={s.error}
              />
            );
          }
          if (s.kind === "warning") {
            return (
              // biome-ignore lint/suspicious/noArrayIndexKey: streamed segments are append-only
              <WarningCard key={i} text={s.text} severity={s.severity} />
            );
          }
          if (s.kind === "image") {
            return (
              // biome-ignore lint/suspicious/noArrayIndexKey: streamed segments are append-only
              <AssistantImage key={i} dataUrl={s.dataUrl} mimeType={s.mimeType} />
            );
          }
          // tool segment
          const pendingConfirm =
            (s.name === "run_command" || s.name === "run_background") && s.result === undefined
              ? pendingConfirms.find((c) => c.command === extractCommand(s.args))
              : undefined;
          const isSubagent =
            (s.subagentRuns !== undefined && s.subagentRuns.length > 0) ||
            isSubagentTool(s.name, s.args);
          if (isSubagent) {
            const { task, skillName, model } = extractSubagentDetails(s.name, s.args);
            const status: "running" | "done" | "failed" =
              s.result !== undefined ? (s.ok === false ? "failed" : "done") : "running";
            const resultMeta = extractSubagentResultMeta(s.result);
            const runs =
              s.subagentRuns && s.subagentRuns.length > 0
                ? s.subagentRuns
                : [
                    {
                      runId: s.callId,
                      task,
                      skillName,
                      model: resultMeta.model ?? model,
                      status,
                      elapsedMs: resultMeta.elapsedMs,
                      turns: resultMeta.turns,
                      costUsd: resultMeta.costUsd,
                      billingKind: resultMeta.billingKind,
                      quotaUsedPct: resultMeta.quotaUsedPct,
                      tools: [],
                    },
                  ];
            const effectiveRuns =
              s.result !== undefined
                ? runs.map((r) =>
                    r.status === "running"
                      ? { ...r, status: (s.ok === false ? "failed" : "done") as "failed" | "done" }
                      : r,
                  )
                : runs;
            return (
              <SubagentCard
                // biome-ignore lint/suspicious/noArrayIndexKey: streamed segments are append-only
                key={i}
                name={skillName}
                runs={effectiveRuns}
                args={s.args}
                result={s.result}
                ok={s.ok}
                durationMs={s.durationMs}
              />
            );
          }
          if (s.name === "run_command" || s.name === "run_background") {
            const cmd = extractCommand(s.args) ?? s.args;
            // A `run_background` call returns as soon as its startup wait
            // elapses — long before the process ends. Resolve the card from the
            // job's LIVE status so a still-downloading curl never reads "done".
            const job =
              s.name === "run_background" && s.result !== undefined
                ? findBackgroundJob(jobs, tabId, parseBackgroundJobId(s.result))
                : undefined;
            const state: "await" | "running" | "done" | "failed" =
              s.result === undefined
                ? pendingConfirm
                  ? "await"
                  : "running"
                : job !== undefined
                  ? job.running
                    ? "running"
                    : job.exitCode === 0
                      ? "done"
                      : "failed"
                  : s.ok === false
                    ? "failed"
                    : "done";
            const jobRunning = state === "running" && job !== undefined;
            return (
              <ShellCard
                // biome-ignore lint/suspicious/noArrayIndexKey: streamed segments are append-only
                key={i}
                command={cmd}
                // While the job runs, the live tail is the source of truth — the
                // tool result only holds the (already stale) startup banner.
                output={jobRunning ? undefined : s.result}
                liveOutput={jobRunning ? job?.outputTail : s.liveOutput}
                state={state}
                background={jobRunning}
                durationMs={jobRunning ? undefined : s.durationMs}
                onApprove={pendingConfirm ? () => onApproveConfirm(pendingConfirm.id) : undefined}
                onReject={pendingConfirm ? () => onRejectConfirm(pendingConfirm.id) : undefined}
                onAlwaysAllow={
                  pendingConfirm
                    ? () => {
                        onAlwaysAllowConfirm(pendingConfirm.id, derivePrefix(cmd));
                      }
                    : undefined
                }
                onStop={
                  jobRunning && job !== undefined && onStopJob
                    ? () => onStopJob(job.id)
                    : onStopTool
                }
              />
            );
          }
          if (
            s.name === "submit_plan" &&
            activePlan?.callId !== undefined &&
            s.callId === activePlan.callId
          ) {
            return <ActivePlanTaskCard key={s.callId} plan={activePlan} />;
          }
          if (s.result && (s.name === "edit_file" || s.name === "multi_edit")) {
            const files = parseEditResult(s.result);
            return files.length > 0 ? (
              <Fragment key={s.callId ?? `edit-${i}`}>
                {files.map((f, fi) => (
                  <DiffCard
                    // biome-ignore lint/suspicious/noArrayIndexKey: streamed segments are append-only
                    key={`${i}-${fi}`}
                    filename={f.filename}
                    lines={f.lines}
                    applied={s.ok !== false}
                  />
                ))}
              </Fragment>
            ) : (
              <ToolCard
                // biome-ignore lint/suspicious/noArrayIndexKey: streamed segments are append-only
                key={i}
                name={s.name}
                args={s.args}
                result={s.result}
                ok={s.ok}
                durationMs={s.durationMs}
              />
            );
          }
          return (
            <ToolCard
              // biome-ignore lint/suspicious/noArrayIndexKey: streamed segments are append-only
              key={i}
              name={s.name}
              args={s.args}
              result={s.result}
              ok={s.ok}
              durationMs={s.durationMs}
              waiting={
                s.result === undefined &&
                Boolean(
                  isInterventionPending ||
                    pendingConfirm ||
                    s.name === "ask_choice" ||
                    s.name === "submit_plan" ||
                    s.name === "revise_plan" ||
                    s.name === "mark_step_complete",
                )
              }
            />
          );
        })}
        {content ? (
          <div className="msg-actions">
            <button
              type="button"
              className={`copy-btn ${copied ? "done" : ""}`}
              onClick={onCopy}
              title={t("thread.copyResponse")}
            >
              <Copy size={11} />
              {copied ? t("markdown.copied") : null}
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
});

function extractCommand(args: string): string | undefined {
  if (!args) return undefined;
  try {
    const v = JSON.parse(args);
    if (v && typeof v === "object" && typeof v.command === "string") return v.command;
  } catch {
    // ignore
  }
  return undefined;
}

/** Parse the job id out of a `run_background` tool result header, e.g.
 *  `[job 7 started · pid 12168 · running (no ready signal yet)]`. Mirrors the
 *  header emitted by `formatJobStart` (src/tools/shell.ts). */
export function parseBackgroundJobId(result: string): number | undefined {
  const m = /^\[job (\d+) (?:started|exited|failed)/.exec(result);
  return m ? Number(m[1]) : undefined;
}

/** Resolve the live job record a `run_background` card points at, scoped to the
 *  owning tab — per-tab registries restart job ids at 1, so id alone collides
 *  across tabs. */
export function findBackgroundJob(
  jobs: JobInfo[] | undefined,
  tabId: string | undefined,
  jobId: number | undefined,
): JobInfo | undefined {
  if (!jobs || jobId === undefined) return undefined;
  return jobs.find((j) => j.id === jobId && (tabId === undefined || j.tabId === tabId));
}

// ---- Approval bindings ----

export function PlanApprovalCard({
  p,
  onApprove,
  onRefine,
  onCancel,
}: {
  p: PendingPlan;
  onApprove: () => void;
  onRefine: () => void;
  onCancel: () => void;
}) {
  useLang();
  const stepCount = p.steps?.length ?? 0;
  const sub = stepCount > 0 ? t("thread.planStepCount", { count: stepCount }) : undefined;
  const remaining = useAutoApproveCountdown(p.countdownMs, onApprove);
  return (
    <ApprovalCard
      kind={t("thread.planConfirmationKind")}
      tone="info"
      title={t("thread.startPlan")}
      sub={sub}
      body={
        <>
          {remaining !== null ? (
            <div style={{ marginBottom: 6, fontSize: 11.5, color: "var(--tone-warn)" }}>
              {t("thread.autoApproveIn", { n: remaining })}
            </div>
          ) : null}
          {p.summary ? <div style={{ marginBottom: 6 }}>{p.summary}</div> : null}
          <PreText>{p.plan}</PreText>
        </>
      }
      meta={`plan/#${p.id}`}
      primaryLabel={t("thread.approve")}
      secondaryLabel={t("thread.cancel")}
      tertiaryLabel={t("thread.refine")}
      onPrimary={onApprove}
      onSecondary={onCancel}
      onTertiary={onRefine}
    />
  );
}

export function CheckpointApprovalCard({
  c,
  onContinue,
  onRevise,
  onStop,
}: {
  c: PendingCheckpoint;
  onContinue: () => void;
  onRevise: () => void;
  onStop: () => void;
}) {
  useLang();
  return (
    <ApprovalCard
      kind={t("thread.checkpointKind")}
      tone="brand"
      title={c.title ?? t("thread.checkpointTitle", { completed: c.completed, total: c.total })}
      sub={t("thread.checkpointSub", { completed: c.completed, total: c.total })}
      body={
        <>
          <PreText>{c.result}</PreText>
          {c.notes ? (
            <div style={{ marginTop: 8, fontSize: 11.5, color: "var(--muted)" }}>{c.notes}</div>
          ) : null}
        </>
      }
      meta={`checkpoint · ${c.stepId}`}
      primaryLabel={t("thread.continue")}
      secondaryLabel={t("thread.stop")}
      tertiaryLabel={t("thread.revise")}
      onPrimary={onContinue}
      onSecondary={onStop}
      onTertiary={onRevise}
    />
  );
}

export function RevisionApprovalCard({
  r,
  onAccept,
  onReject,
}: {
  r: PendingRevision;
  onAccept: () => void;
  onReject: () => void;
}) {
  useLang();
  const remaining = useAutoApproveCountdown(r.countdownMs, onAccept);
  return (
    <ApprovalCard
      kind={t("thread.planRevisionKind")}
      tone="warn"
      title={t("thread.rewritePlan")}
      sub={t("thread.keepSteps", { n: r.remainingSteps.length })}
      body={
        <>
          {remaining !== null ? (
            <div style={{ marginBottom: 8, fontSize: 11.5, color: "var(--tone-warn)" }}>
              {t("thread.autoApproveIn", { n: remaining })}
            </div>
          ) : null}
          <div style={{ marginBottom: 8 }}>{r.reason}</div>
          {r.summary ? (
            <div style={{ fontSize: 11.5, color: "var(--muted)", marginBottom: 8 }}>
              {r.summary}
            </div>
          ) : null}
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            {r.remainingSteps.map((s) => (
              <li key={s.id} style={{ fontSize: 12, marginBottom: 2 }}>
                {s.title}
                {s.risk ? (
                  <span
                    style={{
                      marginLeft: 6,
                      fontSize: 10,
                      color:
                        s.risk === "high"
                          ? "var(--tone-err)"
                          : s.risk === "med"
                            ? "var(--tone-warn)"
                            : "var(--muted)",
                    }}
                  >
                    [{s.risk}]
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        </>
      }
      meta={t("thread.revisionMeta")}
      primaryLabel={t("thread.approveRewrite")}
      secondaryLabel={t("thread.keepOriginal")}
      onPrimary={onAccept}
      onSecondary={onReject}
    />
  );
}

function mapTone(tone: ApprovalPrompt["tone"]): import("./extra-cards").ApprovalTone {
  switch (tone) {
    case "error":
      return "danger";
    case "accent":
      return "brand";
    default:
      return tone;
  }
}

export function ConfirmApprovalCard({
  prompt,
  onAllow,
  onAlwaysAllow,
  onDeny,
}: {
  prompt: ApprovalPrompt;
  onAllow: () => void;
  onAlwaysAllow: (prefix: string) => void;
  onDeny: () => void;
}) {
  useLang();
  const prefix = String(prompt.data?.prefix ?? "");
  const allowAction = prompt.actions.find((a) => a.kind === "allow_once");
  const alwaysAllowAction = prompt.actions.find((a) => a.kind === "allow_always");
  const rejectAction = prompt.actions.find((a) => a.kind === "reject");
  return (
    <ApprovalCard
      kind={
        prompt.kind === "email" ? t("thread.emailConfirmationKind") : t("thread.shellConfirmationKind")
      }
      tone={mapTone(prompt.tone)}
      title={prompt.title}
      sub={prompt.subtitle}
      preview={
        prompt.kind === "email" ? (
          <PreText>
            {Object.entries(prompt.meta ?? {}).map(([key, value]) => (
              <div key={key}>
                <strong>{key}:</strong> {value}
              </div>
            ))}
            <div style={{ marginTop: 8 }}>{prompt.preview}</div>
          </PreText>
        ) : (
          <>
            <span style={{ color: "var(--accent)" }}>$</span> {prompt.preview ?? prompt.subtitle}
          </>
        )
      }
      meta={
        prompt.kind === "email"
          ? t("thread.emailConfirmationMeta")
          : t("thread.riskMedium", {
              kind: prompt.kind === "shell" ? "run_command" : "run_background",
            })
      }
      primaryLabel={allowAction?.label ?? t("thread.execute")}
      secondaryLabel={rejectAction?.label ?? t("thread.reject")}
      tertiaryLabel={
        prompt.kind === "email"
          ? undefined
          : (alwaysAllowAction?.label ?? t("thread.alwaysAllow", { prefix }))
      }
      onPrimary={onAllow}
      onSecondary={onDeny}
      onTertiary={prompt.kind === "email" ? undefined : () => onAlwaysAllow(prefix)}
    />
  );
}

export function PathAccessApprovalCard({
  prompt,
  onAllow,
  onAlwaysAllow,
  onDeny,
}: {
  prompt: ApprovalPrompt;
  onAllow: () => void;
  onAlwaysAllow: (prefix: string) => void;
  onDeny: () => void;
}) {
  useLang();
  const prefix = String(prompt.data?.prefix ?? "");
  const intent = String(prompt.data?.intent ?? "read");
  const isWrite = intent === "write";
  const allowAction = prompt.actions.find((a) => a.kind === "allow_once");
  const alwaysAllowAction = prompt.actions.find((a) => a.kind === "allow_always");
  const rejectAction = prompt.actions.find((a) => a.kind === "reject");
  return (
    <ApprovalCard
      kind={t("thread.pathAccessKind")}
      tone={mapTone(prompt.tone)}
      title={prompt.title}
      sub={prompt.subtitle}
      preview={
        <>
          <div>{prompt.preview ?? prompt.subtitle}</div>
          {prompt.meta?.sandboxRoot ? (
            <div style={{ color: "var(--muted)", marginTop: 4 }}>
              workspace: {prompt.meta.sandboxRoot}
            </div>
          ) : null}
        </>
      }
      meta={t("thread.riskMedium", { kind: intent })}
      primaryLabel={
        allowAction?.label ?? (isWrite ? t("thread.allowWrite") : t("thread.allowRead"))
      }
      secondaryLabel={rejectAction?.label ?? t("thread.reject")}
      tertiaryLabel={alwaysAllowAction?.label ?? t("thread.alwaysAllowPrefix", { prefix })}
      onPrimary={onAllow}
      onSecondary={onDeny}
      onTertiary={() => onAlwaysAllow(prefix)}
    />
  );
}

export function ChoiceApprovalCard({
  c,
  onPick,
  onCancel,
}: {
  c: PendingChoice;
  onPick: (optionId: string) => void;
  onCancel: () => void;
}) {
  useLang();
  const firstOptionId = c.options[0]?.id;
  const remaining = useAutoApproveCountdown(c.countdownMs, () => {
    if (firstOptionId) onPick(firstOptionId);
  });
  return (
    <ApprovalCard
      kind={t("thread.userChoiceKind")}
      tone="info"
      title={c.question}
      sub={t("thread.optionCount", { count: c.options.length })}
      body={
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {remaining !== null ? (
            <div style={{ marginBottom: 2, fontSize: 11.5, color: "var(--tone-warn)" }}>
              {t("thread.autoApproveIn", { n: remaining })}
            </div>
          ) : null}
          {c.options.map((o) => (
            <button
              key={o.id}
              type="button"
              className="btn"
              style={{ justifyContent: "flex-start", textAlign: "left" }}
              onClick={() => onPick(o.id)}
            >
              <div>
                <div style={{ fontWeight: 600 }}>{o.title}</div>
                {o.summary ? (
                  <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 2 }}>
                    {o.summary}
                  </div>
                ) : null}
              </div>
            </button>
          ))}
        </div>
      }
      primaryLabel={t("thread.cancel")}
      onPrimary={onCancel}
    />
  );
}

export function activePlanToTaskSteps(plan: ActivePlan): TaskStepView[] {
  const done = new Set(plan.completedStepIds);
  return plan.steps.map((s, i) => ({
    n: String(i + 1),
    state: done.has(s.id) ? "done" : i === plan.completedStepIds.length ? "running" : "queued",
    label: s.title,
    hint: s.action,
    durationLabel: undefined,
  }));
}

export function ActivePlanTaskCard({ plan }: { plan: ActivePlan }) {
  useLang();
  return (
    <TaskCard
      title={t("thread.activePlan")}
      subtitle={plan.summary}
      steps={activePlanToTaskSteps(plan)}
    />
  );
}
