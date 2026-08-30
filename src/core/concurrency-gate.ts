interface Pending {
  task: () => Promise<unknown>;
  resolve: (result: { value: unknown; queueWaitMs: number }) => void;
  reject: (error: unknown) => void;
  enqueuedAt: number;
  priority: number;
}

export class ConcurrencyGate {
  private active = 0;
  private readonly pending: Pending[] = [];

  constructor(private readonly limit: number) {
    if (!Number.isInteger(limit) || limit < 1)
      throw new Error("concurrency limit must be positive");
  }

  run<T>(task: () => Promise<T>, priority = 0): Promise<{ value: T; queueWaitMs: number }> {
    return new Promise((resolve, reject) => {
      this.pending.push({
        task,
        resolve: (result) => resolve(result as { value: T; queueWaitMs: number }),
        reject,
        enqueuedAt: performance.now(),
        priority,
      });
      this.pending.sort((a, b) => b.priority - a.priority || a.enqueuedAt - b.enqueuedAt);
      this.drain();
    });
  }

  private drain(): void {
    while (this.active < this.limit && this.pending.length > 0) {
      const item = this.pending.shift();
      if (!item) return;
      this.active += 1;
      const queueWaitMs = performance.now() - item.enqueuedAt;
      item
        .task()
        .then((value) => item.resolve({ value, queueWaitMs }), item.reject)
        .finally(() => {
          this.active -= 1;
          this.drain();
        });
    }
  }
}
