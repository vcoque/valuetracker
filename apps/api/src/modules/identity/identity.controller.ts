import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Patch,
  Post,
  Req,
  Res,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';

import { z } from 'zod';

import { RateLimit, RateLimitGuard } from '../../shared/http/rate-limit.guard';
import { ZodValidationPipe } from '../../shared/http/zod-validation.pipe';
import { AuthGuard } from './auth.guard';
import { CurrentUser } from './current-user.decorator';
import {
  type AuthResponse,
  type LoginRequest,
  loginRequestSchema,
  type MeResponse,
  type RefreshRequest,
  refreshRequestSchema,
  type RegisterRequest,
  registerRequestSchema,
  type SessionSummary,
  type UpdateMeRequest,
  updateMeRequestSchema,
} from './dto/auth.dto';
import {
  IdentityService,
  type IssuedSession,
  type SessionContext,
} from './identity.service';
import {
  REFRESH_COOKIE_NAME,
  serializeClearedRefreshCookie,
  serializeRefreshCookie,
} from './refresh-cookie';

/**
 * A real browser refresh is `fetch('/auth/refresh', { method: 'POST',
 * credentials: 'include' })` -- no body at all. Treat a missing / empty body as
 * `{}` so the cookie is still read; a body that IS sent is validated strictly
 * (`refreshRequestSchema.strict()`), so a mistyped field is still a 400.
 */
const refreshBodySchema = z.preprocess(
  (value) => (value === undefined || value === null || value === '' ? {} : value),
  refreshRequestSchema,
);

/**
 * Minimal structural views of the Fastify request/reply -- only the members the
 * controller touches. Avoids a source dependency on `fastify` (a transitive
 * package) while keeping the handler typed. `cookies` is populated by
 * `@fastify/cookie`, registered in `main.ts` bootstrap and in
 * `identity.e2e-spec.ts`'s app setup (a shared e2e app factory is a deferred
 * follow-up).
 */
interface RequestView {
  readonly ip?: string;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly cookies?: Record<string, string | undefined>;
}

interface ReplyView {
  header(name: string, value: string): unknown;
}

/**
 * Rate limits (Ruling S10). Tunable. Register is tighter than login because an
 * open-signup endpoint on the public internet is the more attractive target for
 * enumeration and automated abuse (SPEC-identity.md last AC). `/auth/refresh`
 * is limited too -- it is reachable without an access token. The
 * `AuthGuard`-protected routes are not IP-limited: a valid token is the gate.
 */
const RATE_LIMIT_WINDOW_MS = 60_000;
const REGISTER_RATE_LIMIT = 5;
const LOGIN_RATE_LIMIT = 10;
const REFRESH_RATE_LIMIT = 30;

@Controller('auth')
@UseGuards(RateLimitGuard)
export class IdentityController {
  constructor(private readonly identity: IdentityService) {}

  @Post('register')
  @HttpCode(HttpStatus.CREATED)
  @RateLimit({ limit: REGISTER_RATE_LIMIT, windowMs: RATE_LIMIT_WINDOW_MS })
  async register(
    @Body(new ZodValidationPipe(registerRequestSchema)) body: RegisterRequest,
    @Req() request: RequestView,
    @Res({ passthrough: true }) reply: ReplyView,
  ): Promise<AuthResponse> {
    const issued = await this.identity.register(body, contextOf(request));
    return transportFor(issued, reply);
  }

  @Post('login')
  @HttpCode(HttpStatus.OK)
  @RateLimit({ limit: LOGIN_RATE_LIMIT, windowMs: RATE_LIMIT_WINDOW_MS })
  async login(
    @Body(new ZodValidationPipe(loginRequestSchema)) body: LoginRequest,
    @Req() request: RequestView,
    @Res({ passthrough: true }) reply: ReplyView,
  ): Promise<AuthResponse> {
    const issued = await this.identity.login(body, contextOf(request));
    return transportFor(issued, reply);
  }

  /**
   * Exchange a refresh token for a new pair, rotating it. The token is taken
   * from the `refresh_token` cookie when one is present (WEB), otherwise from
   * `refreshToken` in the body (ANDROID). The response transport follows the
   * *session's* recorded `client_type`, not the request.
   */
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @RateLimit({ limit: REFRESH_RATE_LIMIT, windowMs: RATE_LIMIT_WINDOW_MS })
  async refresh(
    @Body(new ZodValidationPipe(refreshBodySchema)) body: RefreshRequest,
    @Req() request: RequestView,
    @Res({ passthrough: true }) reply: ReplyView,
  ): Promise<AuthResponse> {
    // Cookie first, then body token. An ANDROID client that omits `clientType`
    // would otherwise default to WEB and get an opaque 401 despite a valid
    // body token.
    const presented =
      request.cookies?.[REFRESH_COOKIE_NAME] ?? body.refreshToken;

    if (!presented) {
      throw new UnauthorizedException({ message: 'Invalid refresh token' });
    }

    const issued = await this.identity.refresh(presented, contextOf(request));
    return transportFor(issued, reply);
  }

  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(AuthGuard)
  async logout(
    @CurrentUser('sessionId') sessionId: string,
    @Res({ passthrough: true }) reply: ReplyView,
  ): Promise<void> {
    await this.identity.logout(sessionId);
    reply.header('set-cookie', serializeClearedRefreshCookie());
  }

  @Post('logout-all')
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(AuthGuard)
  async logoutAll(
    @CurrentUser() userId: string,
    @Res({ passthrough: true }) reply: ReplyView,
  ): Promise<void> {
    await this.identity.logoutAll(userId);
    reply.header('set-cookie', serializeClearedRefreshCookie());
  }

  @Get('me')
  @UseGuards(AuthGuard)
  me(@CurrentUser() userId: string): Promise<MeResponse> {
    return this.identity.getProfile(userId);
  }

  @Patch('me')
  @UseGuards(AuthGuard)
  updateMe(
    @CurrentUser() userId: string,
    @Body(new ZodValidationPipe(updateMeRequestSchema)) body: UpdateMeRequest,
  ): Promise<MeResponse> {
    return this.identity.updateProfile(userId, body);
  }

  @Get('sessions')
  @UseGuards(AuthGuard)
  sessions(
    @CurrentUser() userId: string,
    @CurrentUser('sessionId') sessionId: string,
  ): Promise<SessionSummary[]> {
    return this.identity.listSessions(userId, sessionId);
  }
}

function contextOf(request: RequestView): SessionContext {
  const userAgent = request.headers['user-agent'];
  return {
    ip: request.ip ?? null,
    userAgent: typeof userAgent === 'string' ? userAgent : null,
  };
}

/**
 * Shape the response by client type. WEB gets the refresh token as an HttpOnly
 * cookie and a body with no `refreshToken`; ANDROID has no cookie jar, so both
 * tokens travel in the body.
 */
function transportFor(issued: IssuedSession, reply: ReplyView): AuthResponse {
  // The response carries tokens; no cache, shared or private, may keep it
  // (RFC 6749 §5.1).
  reply.header('cache-control', 'no-store');

  const body: AuthResponse = {
    accessToken: issued.accessToken,
    tokenType: 'Bearer',
    expiresIn: issued.expiresIn,
  };

  if (issued.clientType === 'WEB') {
    reply.header('set-cookie', serializeRefreshCookie(issued.refreshToken));
    return body;
  }

  return { ...body, refreshToken: issued.refreshToken };
}
