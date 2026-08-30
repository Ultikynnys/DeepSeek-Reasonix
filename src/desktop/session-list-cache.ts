import { resolve } from "node:path";

interface Entry<T> {
  value: T;
  expiresAt: number;
}

export class SessionListCache<T> {
  private readonly cached = new Map<string, Entry<T>>();
  private readonly inflight = new Map<string, Promise<T>>();

  constructor(
    private readonly loader: (workspace: string) => Promise<T>,
    private readonly ttlMs = 3_000,
    private readonly now: () => number = Date.now,
  ) {}

  load(workspace: string): { value: Promise<T>; cache: "hit" | "miss" | "inflight" } {
    const key = this.key(workspace);
    const cached = this.cached.get(key);
    if (cached && cached.expiresAt > this.now()) {
      return { value: Promise.resolve(cached.value), cache: "hit" };
    }
    const active = this.inflight.get(key);
    if (active) return { value: active, cache: "inflight" };
    const request = this.loader(workspace)
      .then((value) => {
        this.cached.set(key, { value, expiresAt: this.now() + this.ttlMs });
        return value;
      })
      .finally(() => {
        if (this.inflight.get(key) === request) this.inflight.delete(key);
      });
    this.inflight.set(key, request);
    return { value: request, cache: "miss" };
  }

  invalidate(workspace?: string): void {
    if (workspace === undefined) {
      this.cached.clear();
      return;
    }
    this.cached.delete(this.key(workspace));
  }

  private key(workspace: string): string {
    return process.platform === "win32" ? resolve(workspace).toLowerCase() : resolve(workspace);
  }
}
