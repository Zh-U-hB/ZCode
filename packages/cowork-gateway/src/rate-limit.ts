/**
 * 内存滑动窗口限流。仅适用于单实例网关；重启即清零。
 * 登录场景的 key 维度由调用方决定（IP / 用户名）。
 */
export class SlidingWindowRateLimiter {
  private readonly hits = new Map<string, number[]>();
  private lastSweep = Date.now();

  constructor(
    private readonly windowMs: number,
    private readonly maxHits: number,
  ) {}

  /** 记录一次命中并返回是否放行。 */
  hit(key: string): boolean {
    const now = Date.now();
    const cutoff = now - this.windowMs;
    const history = (this.hits.get(key) ?? []).filter((t) => t > cutoff);
    if (history.length >= this.maxHits) {
      this.hits.set(key, history);
      this.sweep(now);
      return false;
    }
    history.push(now);
    this.hits.set(key, history);
    this.sweep(now);
    return true;
  }

  /** 只读检查当前是否已处于超限状态。 */
  isLimited(key: string): boolean {
    const now = Date.now();
    const cutoff = now - this.windowMs;
    const history = (this.hits.get(key) ?? []).filter((t) => t > cutoff);
    return history.length >= this.maxHits;
  }

  private sweep(now: number): void {
    if (now - this.lastSweep < 60_000) return;
    this.lastSweep = now;
    const cutoff = now - this.windowMs;
    for (const [key, history] of this.hits) {
      const alive = history.filter((t) => t > cutoff);
      if (alive.length === 0) {
        this.hits.delete(key);
      } else {
        this.hits.set(key, alive);
      }
    }
  }
}
