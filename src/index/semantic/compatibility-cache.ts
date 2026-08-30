import { resolve } from "node:path";

interface Cached {
  value: boolean;
  expiresAt: number;
}

export class SemanticCompatibilityCache {
  private readonly cached = new Map<string, Cached>();
  private readonly inflight = new Map<string, Promise<boolean>>();

  constructor(
    private readonly check: (
      root: string,
      options: { provider?: "ollama" | "openai-compat"; model?: string },
    ) => Promise<boolean>,
    private readonly ttlMs = 30_000,
    private readonly now: () => number = Date.now,
  ) {}

  get(
    root: string,
    options: { provider?: "ollama" | "openai-compat"; model?: string } = {},
  ): Promise<boolean> {
    const key = this.key(root, options);
    const cached = this.cached.get(key);
    if (cached && cached.expiresAt > this.now()) return Promise.resolve(cached.value);
    const active = this.inflight.get(key);
    if (active) return active;
    const request = this.check(root, options)
      .then((value) => {
        this.cached.set(key, { value, expiresAt: this.now() + this.ttlMs });
        return value;
      })
      .finally(() => {
        if (this.inflight.get(key) === request) this.inflight.delete(key);
      });
    this.inflight.set(key, request);
    return request;
  }

  invalidate(root?: string): void {
    if (root === undefined) {
      this.cached.clear();
      return;
    }
    const prefix = `${this.normalize(root)}\u0000`;
    for (const key of this.cached.keys()) if (key.startsWith(prefix)) this.cached.delete(key);
  }

  private key(
    root: string,
    options: { provider?: "ollama" | "openai-compat"; model?: string },
  ): string {
    return `${this.normalize(root)}\u0000${options.provider ?? ""}\u0000${options.model ?? ""}`;
  }

  private normalize(root: string): string {
    const normalized = resolve(root);
    return process.platform === "win32" ? normalized.toLowerCase() : normalized;
  }
}
