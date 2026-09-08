import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';

import { RateLimit, RateLimitGuard } from '../../shared/http/rate-limit.guard';
import { ZodValidationPipe } from '../../shared/http/zod-validation.pipe';
import {
  type AuthResponse,
  type LoginRequest,
  loginRequestSchema,
  type RegisterRequest,
  registerRequestSchema,
} from './dto/auth.dto';
import {
  IdentityService,
  type IssuedSession,
  type SessionContext,
} from './identity.service';
import { serializeRefreshCookie } from './refresh-cookie';

/**
 * Minimal structural views of the Fastify request/reply -- only the members the
 * controller touches. Avoids a source dependency on `fastify` (a transitive
 * package) while keeping the handler typed.
 */
interface RequestView {
  readonly ip?: string;
  readonly headers: Record<string, string | string[] | undefined>;
}

interface ReplyView {
  header(name: string, value: string): unknown;
}

/**
 * Rate limits (Ruling S10). Tunable. Register is tighter than login because an
 * open-signup endpoint on the public internet is the more attractive target for
 * enumeration and automated abuse (SPEC-identity.md last AC).
 */
const RATE_LIMIT_WINDOW_MS = 60_000;
const REGISTER_RATE_LIMIT = 5;
const LOGIN_RATE_LIMIT = 10;

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
