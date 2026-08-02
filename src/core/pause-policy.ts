/** Shared editMode → auto-resolve rules so CLI TUI + Tauri desktop don't drift. */

import type { EditMode } from "../config.js";
import type { PauseRequest } from "./pause-gate.js";

/** Mirrors shell.ts's allowAll bypass: only review still pauses on checkpoints. */
export function shouldAutoResolveCheckpoint(editMode: EditMode): boolean {
  return editMode === "auto" || editMode === "yolo";
}

/** null = surface to user; non-null = resolve gate immediately with this verdict. */
export function autoResolveVerdict(req: PauseRequest, editMode: EditMode): unknown | null {
  if (req.kind === "plan_checkpoint" && shouldAutoResolveCheckpoint(editMode)) {
    return { type: "continue" };
  }
  // yolo mirrors shell.ts's allowAll bypass — outside-sandbox reads/writes pass
  // through too. Stays "run_once" rather than "always_allow" so the YOLO session
  // doesn't pollute the on-disk allowlist with every transient path it touched.
  if (req.kind === "path_access" && editMode === "yolo") {
    return { type: "run_once" };
  }
  // Shell commands in YOLO: shell.ts's `allowAll` callback should already have
  // skipped gate.ask for these, but the closure reads on-disk config via
  // `loadEditMode()` while ACP's `--yolo` flag and any future runtime-only
  // YOLO source don't write to config. Without this second layer those paths
  // surface a confirmation prompt even though the user is in YOLO (#1448).
  // `run_once` matches shell.ts's behavior — don't pollute the persistent
  // allowlist with every transient command.
  if ((req.kind === "run_command" || req.kind === "run_background") && editMode === "yolo") {
    return { type: "run_once" };
  }
  // YOLO: plan_proposed — the plan gate would strand the loop on an approval
  // picker nobody is watching (headless/ACP/YOLO). Auto-approve so the model
  // can execute the plan without blocking. plan_checkpoint below is already
  // auto-continued; this closes the remaining interaction gap.
  if (req.kind === "plan_proposed" && editMode === "yolo") {
    return { type: "approve" };
  }
  // YOLO: an ask_choice branch question would strand the loop on a picker
  // nobody is watching (headless/ACP runs especially) — auto-pick the first
  // option so the model carries on with the leading branch. Cancel is just a
  // hang-proof fallback; choice.ts already sanitizes options before gating.
  if (req.kind === "choice" && editMode === "yolo") {
    const payload = req.payload as { options?: unknown[] };
    const first = Array.isArray(payload.options) ? payload.options[0] : undefined;
    const id = first && typeof first === "object" ? (first as { id?: unknown }).id : undefined;
    if (typeof id === "string" && id.length > 0) return { type: "pick", optionId: id };
    return { type: "cancel" };
  }
  return null;
}
