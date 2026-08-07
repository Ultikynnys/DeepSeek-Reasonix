/** Verdict shapes returned by the permission gate (PauseGate → UI modal → user choice).
 *  These types are shared between the core loop, the ACP bridge, and any
 *  future UI surface that needs to render or resolve a permission prompt. */

export type ConfirmationChoice =
  | { type: "deny"; denyContext?: string }
  | { type: "run_once" }
  | { type: "always_allow"; prefix: string };

export type PlanVerdict =
  | { type: "approve"; feedback?: string }
  | { type: "refine"; feedback?: string }
  | { type: "cancel"; feedback?: string };

export type CheckpointVerdict =
  | { type: "continue" }
  | { type: "revise"; feedback?: string }
  | { type: "stop" };

export type RevisionVerdict = { type: "accepted" } | { type: "rejected" } | { type: "cancelled" };

export type ChoiceVerdict =
  | { type: "pick"; optionId: string }
  | { type: "text"; text: string }
  | { type: "cancel" };

/** Reasoning effort levels — shared between config, model calls, and desktop UI.
 *  `xhigh` sits between `high` and `max` (GPT-5.6 family ladder). Endpoints that
 *  don't accept a level reject the request — callers surface the 400 as-is. */
export type ReasoningEffort = "low" | "medium" | "high" | "xhigh" | "max";

/** A choice option shown in the desktop picker — shared with the ask_choice tool. */
export type ChoiceOption = {
  id: string;
  title: string;
  summary?: string;
};

/** A plan step as passed over the wire to the desktop.  The canonical rich
 *  server-side PlanStep (with targets / acceptance / verification) extends
 *  this shape in `src/tools/plan-types.ts`. */
export type PlanStep = {
  id: string;
  title: string;
  action: string;
  risk?: "low" | "med" | "high";
};
