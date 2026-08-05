import type { PlanStep as CorePlanStep } from "@reasonix/core-utils";

export type PlanStepRisk = "low" | "med" | "high";

export interface PlanStep extends CorePlanStep {
  risk?: PlanStepRisk;
  targets?: string[];
  acceptance?: string;
  verification?: string[];
}

export type StepEvidenceKind = "verification" | "diff" | "checkpoint" | "manual";

export interface StepEvidence {
  kind: StepEvidenceKind;
  summary: string;
  command?: string;
  paths?: string[];
}

export interface StepCompletion {
  kind: "step_completed";
  stepId: string;
  title?: string;
  result: string;
  notes?: string;
  evidenceSummary?: string;
  evidence?: StepEvidence[];
}
