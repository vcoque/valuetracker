import { SlidingWindowRateLimiter } from './sliding-window-rate-limiter';

/**
 * The window logic behind `RateLimitGuard` (Ruling S10). A fixed clock is
 * passed in on every call so the tests are deterministic and fast.
 */
describe('SlidingWindowRateLimiter', () => {
  it('allows exactly `limit` hits in a window, then rejects', () => {
    const limiter = new SlidingWindowRateLimiter(3, 60_000);
    const now = 1_000_000;

    expect(limiter.tryConsume('ip', now)).toBe(true);
    expect(limiter.tryConsume('ip', now)).toBe(true);
    expect(limiter.tryConsume('ip', now)).toBe(true);
    expect(limiter.tryConsume('ip', now)).toBe(false);
    expect(limiter.tryConsume('ip', now + 59_999)).toBe(false);
  });

  it('recovers once the oldest hit slides out of the window', () => {
    const limiter = new SlidingWindowRateLimiter(2, 60_000);
    const start = 1_000_000;

    expect(limiter.tryConsume('ip', start)).toBe(true);
    expect(limiter.tryConsume('ip', start + 10_000)).toBe(true);
    expect(limiter.tryConsume('ip', start + 20_000)).toBe(false);

    // The first hit (t=start) ages out at start+60_000; the second (t+10_000)
    // is still in-window, so one slot is free and no more.
    expect(limiter.tryConsume('ip', start + 60_001)).toBe(true);
    expect(limiter.tryConsume('ip', start + 60_001)).toBe(false);
  });

  it('counts each key independently', () => {
    const limiter = new SlidingWindowRateLimiter(1, 60_000);
    const now = 1_000_000;

    expect(limiter.tryConsume('a', now)).toBe(true);
    expect(limiter.tryConsume('b', now)).toBe(true);
    expect(limiter.tryConsume('a', now)).toBe(false);
    expect(limiter.tryConsume('b', now)).toBe(false);
  });

  it('does not record a rejected hit, so backing off restores capacity on schedule', () => {
    const limiter = new SlidingWindowRateLimiter(1, 60_000);
    const start = 1_000_000;

    expect(limiter.tryConsume('ip', start)).toBe(true);
    // Hammering during the window must not push the recovery time outward.
    for (let t = start + 1_000; t < start + 60_000; t += 1_000) {
      expect(limiter.tryConsume('ip', t)).toBe(false);
    }
    expect(limiter.tryConsume('ip', start + 60_001)).toBe(true);
  });

  it('prunes keys whose hits have all aged out so the map cannot grow unbounded', () => {
    const limiter = new SlidingWindowRateLimiter(5, 60_000);

    for (let i = 0; i < 1_000; i++) {
      limiter.tryConsume(`ip-${i}`, 1_000_000 + i);
    }
    expect(limiter.trackedKeys).toBe(1_000);

    // A later call past every previous window triggers the sweep.
    limiter.tryConsume('fresh', 1_000_000 + 60_000 + 2_000);
    expect(limiter.trackedKeys).toBe(1);
  });
});
