export interface LoadingTimingStep {
  step: string;
  tabId?: string;
  deltaMs: number;
  cumulativeMs: number;
  details?: Record<string, unknown>;
}

export class StartupTimingTracker {
  private readonly startedAt: number;
  private lastMark: number;
  private readonly steps: LoadingTimingStep[] = [];
  private completed = false;

  constructor(startedAt: number = performance.now()) {
    this.startedAt = startedAt;
    this.lastMark = startedAt;
  }

  mark(
    step: string,
    options: { tabId?: string; details?: Record<string, unknown> } = {},
  ): LoadingTimingStep {
    const now = performance.now();
    const deltaMs = Number((now - this.lastMark).toFixed(2));
    const cumulativeMs = Number((now - this.startedAt).toFixed(2));
    this.lastMark = now;

    const entry: LoadingTimingStep = {
      step,
      ...(options.tabId ? { tabId: options.tabId } : {}),
      deltaMs,
      cumulativeMs,
      ...(options.details ? { details: options.details } : {}),
    };
    this.steps.push(entry);

    const tabPrefix = options.tabId ? ` [tab:${options.tabId}]` : "";
    const detailText = options.details ? ` ${JSON.stringify(options.details)}` : "";
    console.info(
      `[reasonix loading] +${deltaMs}ms (total: ${cumulativeMs}ms)${tabPrefix} ${step}${detailText}`,
    );

    return entry;
  }

  finish(reason: string, details: Record<string, unknown> = {}): void {
    if (this.completed) return;
    this.completed = true;
    const finalStep = this.mark(`throbber_dismissed:${reason}`, { details });
    console.info(
      `[reasonix loading] complete in ${finalStep.cumulativeMs}ms (${this.steps.length} steps logged)`,
      { steps: this.steps },
    );
  }

  fail(reason: string, details: Record<string, unknown> = {}): void {
    if (this.completed) return;
    this.completed = true;
    const finalStep = this.mark(`loading_failed:${reason}`, { details });
    console.warn(`[reasonix loading] aborted after ${finalStep.cumulativeMs}ms: ${reason}`, {
      steps: this.steps,
    });
  }
}
