import { type ExecutionContext, HttpException } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';

import { RateLimitGuard, type RateLimitOptions } from './rate-limit.guard';

/**
 * `RateLimitGuard` translates the sliding window into HTTP: 429 with a generic
 * body on exceed, and a route with no `@RateLimit` is untouched. The window
 * maths itself is covered by `sliding-window-rate-limiter.spec.ts`.
 */
describe('RateLimitGuard', () => {
  function contextFor(handler: object, ip: string): ExecutionContext {
    return {
      getHandler: () => handler,
      getClass: () => class {},
      switchToHttp: () => ({
        getRequest: () => ({ ip }),
        getResponse: () => ({}),
        getNext: () => ({}),
      }),
    } as unknown as ExecutionContext;
  }

  function guardWith(options: RateLimitOptions | undefined): RateLimitGuard {
    const reflector = {
      getAllAndOverride: () => options,
    } as unknown as Reflector;
    return new RateLimitGuard(reflector);
  }

  it('passes the first `limit` requests from an IP and rejects the next with 429', () => {
    const guard = guardWith({ limit: 3, windowMs: 60_000 });
    const handler = function login() {};
    const context = contextFor(handler, '203.0.113.7');

    expect(guard.canActivate(context)).toBe(true);
    expect(guard.canActivate(context)).toBe(true);
    expect(guard.canActivate(context)).toBe(true);

    try {
      guard.canActivate(context);
      throw new Error('expected a 429');
    } catch (error) {
      expect(error).toBeInstanceOf(HttpException);
      expect((error as HttpException).getStatus()).toBe(429);
      expect((error as HttpException).getResponse()).toEqual({
        message: 'Too many requests, please try again later',
      });
    }
  });

  it('meters each IP separately', () => {
    const guard = guardWith({ limit: 1, windowMs: 60_000 });
    const handler = function login() {};

    expect(guard.canActivate(contextFor(handler, '198.51.100.1'))).toBe(true);
    expect(guard.canActivate(contextFor(handler, '198.51.100.2'))).toBe(true);
    expect(() =>
      guard.canActivate(contextFor(handler, '198.51.100.1')),
    ).toThrow(HttpException);
  });

  it('does not limit a handler that carries no @RateLimit metadata', () => {
    const guard = guardWith(undefined);
    const handler = function open() {};
    const context = contextFor(handler, '203.0.113.9');

    for (let i = 0; i < 50; i++) {
      expect(guard.canActivate(context)).toBe(true);
    }
  });

  it('keeps a separate budget per route handler', () => {
    const guard = guardWith({ limit: 1, windowMs: 60_000 });
    const register = function register() {};
    const login = function login() {};

    expect(guard.canActivate(contextFor(register, '203.0.113.5'))).toBe(true);
    expect(guard.canActivate(contextFor(login, '203.0.113.5'))).toBe(true);
    expect(() =>
      guard.canActivate(contextFor(register, '203.0.113.5')),
    ).toThrow(HttpException);
  });
});
