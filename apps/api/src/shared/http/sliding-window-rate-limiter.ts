/**
 * A per-key sliding-window counter, in process memory.
 *
 * Pure data structure: no NestJS, no clock it does not accept as an argument.
 * `RateLimitGuard` wraps it for HTTP; this is where the window logic lives so it
 * can be unit-tested in isolation (Ruling S10).
 *
 * Sliding rather than fixed window: a fixed window lets a caller send `2 * limit`
 * requests across the boundary between two adjacent windows. The cost is holding
 * one timestamp per in-window hit per key; `prune` drops keys whose last hit has
 * aged out so the map cannot grow without bound.
 *
 * In-memory and per-instance, which matches `@nestjs/throttler`'s default store.
 * `SPEC.md` forbids Redis; a multi-instance deploy needs a shared store and this
 * gets revisited at Task 17 (deploy).
 */
export class SlidingWindowRateLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  /**
   * Record a hit for `key` and report whether it is within the limit. A
   * rejected hit is NOT recorded, so a caller that backs off recovers exactly
   * when the window clears rather than being penalised for retrying.
   */
  tryConsume(key: string, now: number = Date.now()): boolean {
    this.prune(now);

    const threshold = now - this.windowMs;
    const recent = (this.hits.get(key) ?? []).filter((at) => at > threshold);

    if (recent.length >= this.limit) {
      this.hits.set(key, recent);
      return false;
    }

    recent.push(now);
    this.hits.set(key, recent);
    return true;
  }

  /** Number of keys currently tracked. For tests and diagnostics. */
  get trackedKeys(): number {
    return this.hits.size;
  }

  /** Drop every timestamp older than the window, and every key left empty. */
  private prune(now: number): void {
    const threshold = now - this.windowMs;

    for (const [key, timestamps] of this.hits) {
      const fresh = timestamps.filter((at) => at > threshold);
      if (fresh.length === 0) {
        this.hits.delete(key);
      } else if (fresh.length !== timestamps.length) {
        this.hits.set(key, fresh);
      }
    }
  }
}
