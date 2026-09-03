/** Shared editMode → auto-resolve rules so CLI TUI + Tauri desktop don't drift. */

import type { EditMode } from "../config.js";
import type { PauseRequest } from "./pause-gate.js";

/** YOLO interactive gates wait this long before auto-selecting the first option. */
export const YOLO_PLAN_COUNTDOWN_MS = 30_000;

/** Mirrors shell.ts's allowAll bypass: only review still pauses on checkpoints. */
export function shouldAutoResolveCheckpoint(editMode: EditMode): boolean {
  return editMode === "auto" || editMode === "yolo";
}

export type AutoResolveOutcome =
  | { kind: "instant"; verdict: unknown }
  | { kind: "countdown"; verdict: unknown; ms: number };

/** null = surface to user indefinitely; instant = resolve gate immediately;
 *  countdown = surface the picker — the UI shows a countdown and resolves with
 *  `verdict` (the first option) when it expires without a user pick. */
export function autoResolveVerdict(
  req: PauseRequest,
  editMode: EditMode,
): AutoResolveOutcome | null {
  if (req.kind === "plan_checkpoint" && shouldAutoResolveCheckpoint(editMode)) {
    return { kind: "instant", verdict: { type: "continue" } };
  }
  // yolo mirrors shell.ts's allowAll bypass — outside-sandbox reads/writes pass
  // through too. Stays "run_once" rather than "always_allow" so the YOLO session
  // doesn't pollute the on-disk allowlist with every transient path it touched.
  if (req.kind === "path_access" && editMode === "yolo") {
    return { kind: "instant", verdict: { type: "run_once" } };
  }
  // Shell commands in YOLO: shell.ts's `allowAll` callback should already have
  // skipped gate.ask for these, but the closure reads on-disk config via
  // `loadEditMode()` while ACP's `--yolo` flag and any future runtime-only
  // YOLO source don't write to config. Without this second layer those paths
  // surface a confirmation prompt even though the user is in YOLO (#1448).
  // `run_once` matches shell.ts's behavior — don't pollute the persistent
  // allowlist with every transient command.
  if ((req.kind === "run_command" || req.kind === "run_background") && editMode === "yolo") {
    return { kind: "instant", verdict: { type: "run_once" } };
  }
  // YOLO: plan_proposed — instead of approving instantly, surface the picker
  // with a countdown so a watching user can still cancel/refine; the first
  // option (approve) is auto-selected when the window elapses.
  if (req.kind === "plan_proposed" && editMode === "yolo") {
    return { kind: "countdown", verdict: { type: "approve" }, ms: YOLO_PLAN_COUNTDOWN_MS };
  }
  // YOLO: plan_revision — without this the rewrite gate surfaces and stalls
  // forever (nobody is watching in headless/YOLO). Same countdown semantics:
  // the first option (accept rewrite) is auto-selected after the window.
  if (req.kind === "plan_revision" && editMode === "yolo") {
    return { kind: "countdown", verdict: { type: "accepted" }, ms: YOLO_PLAN_COUNTDOWN_MS };
  }
  // YOLO: surface ask_choice with the same manual override window as plan gates,
  // then auto-pick the leading branch so unattended runs cannot strand the loop.
  // Cancel malformed choices immediately as a hang-proof fallback; choice.ts
  // already sanitizes options before gating.
  if (req.kind === "choice" && editMode === "yolo") {
    const payload = req.payload as { options?: unknown[] };
    const first = Array.isArray(payload.options) ? payload.options[0] : undefined;
    const id = first && typeof first === "object" ? (first as { id?: unknown }).id : undefined;
    if (typeof id === "string" && id.length > 0) {
      return {
        kind: "countdown",
        verdict: { type: "pick", optionId: id },
        ms: YOLO_PLAN_COUNTDOWN_MS,
      };
    }
    return { kind: "instant", verdict: { type: "cancel" } };
  }
  return null;
}
