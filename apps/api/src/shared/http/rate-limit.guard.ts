import {
  type CanActivate,
  type ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { SlidingWindowRateLimiter } from './sliding-window-rate-limiter';

export const RATE_LIMIT_METADATA = 'vt:rate-limit';

export interface RateLimitOptions {
  /** Requests allowed per key per window. */
  readonly limit: number;
  /** Window length in milliseconds. */
  readonly windowMs: number;
}

/**
 * Marks a route (or controller) as rate-limited. Pair with
 * `@UseGuards(RateLimitGuard)`:
 *
 *   @Post('login')
 *   @RateLimit({ limit: 10, windowMs: 60_000 })
 *
 * A handler with no `@RateLimit` is not limited even if the guard is applied.
 */
export const RateLimit = (options: RateLimitOptions): MethodDecorator &
  ClassDecorator => SetMetadata(RATE_LIMIT_METADATA, options);

/**
 * Per-IP rate limiting for the auth endpoints (Ruling S10 -- `@nestjs/throttler`
 * cannot install against NestJS 12, so this is hand-rolled).
 *
 * One {@link SlidingWindowRateLimiter} per decorated handler, created on first
 * use and keyed by the handler reference, so `/auth/register` and `/auth/login`
 * count independently with their own limits. The guard is a DI singleton, so
 * those limiters live for the process and accumulate across requests.
 *
 * Client IP is `request.ip`. Fastify populates it; behind a real proxy the
 * adapter needs `trustProxy` set or every request appears to come from the
 * proxy. Do not parse `X-Forwarded-For` by hand.
 *
 * On exceed: HTTP 429 with a generic body. No `Retry-After` -- the window is
 * short and the body says nothing an attacker can tune against.
 */
@Injectable()
export class RateLimitGuard implements CanActivate {
  private readonly limiters = new Map<object, SlidingWindowRateLimiter>();

  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const options = this.reflector.getAllAndOverride<RateLimitOptions | undefined>(
      RATE_LIMIT_METADATA,
      [context.getHandler(), context.getClass()],
    );

    if (!options) {
      return true;
    }

    const handler = context.getHandler();
    let limiter = this.limiters.get(handler);
    if (!limiter) {
      limiter = new SlidingWindowRateLimiter(options.limit, options.windowMs);
      this.limiters.set(handler, limiter);
    }

    const request = context.switchToHttp().getRequest<{ ip?: string }>();
    const key = request.ip ?? 'unknown';

    if (!limiter.tryConsume(key)) {
      throw new HttpException(
        { message: 'Too many requests, please try again later' },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    return true;
  }
}
