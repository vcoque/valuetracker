import {
  type CanActivate,
  type ExecutionContext,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';

import {
  ACCESS_TOKEN_VERIFIER,
  type AccessTokenVerifier,
} from './token.service';

/**
 * What `AuthGuard` attaches to the request once a Bearer token verifies. Other
 * modules read these through the {@link CurrentUser} decorator, never off the
 * raw request.
 */
export interface AuthenticatedRequest {
  userId?: string;
  sessionId?: string;
  readonly headers: Record<string, string | string[] | undefined>;
}

/**
 * The public authentication contract every other module consumes
 * (`SPEC-identity.md` §API Surface). Put it on a route or controller with
 * `@UseGuards(AuthGuard)` after `imports: [IdentityModule]`.
 *
 * **Stateless (Ruling S12).** The guard does exactly one thing: extract the
 * `Authorization: Bearer <jwt>`, verify its signature / `iss` / `aud` / `exp`
 * against the current EdDSA key via {@link TokenService.verifyAccessToken}, and
 * attach `{ userId: sub, sessionId: sid }` to the request. It does **not** load
 * the `session` row -- the access token is designed to cost no database
 * round-trip (`SPEC-identity.md` §Authentication Design), and the API scales
 * horizontally because of it.
 *
 * The trade-off this buys: revoking a session (`logout` / `logout-all`)
 * invalidates the *refresh* token immediately, but a still-valid *access* token
 * keeps working until it expires -- at most 15 minutes (ADR 0003). That window
 * is the SPEC-accepted cost. "Sign out this / all devices" is really enforced
 * at the next refresh, which fails at once.
 *
 * Every rejection -- no header, malformed header, expired, bad signature,
 * `alg: none`, unknown `kid`, wrong `iss`/`aud` -- is a 401. The verifier
 * wraps every `jose` error, so nothing here can 500.
 *
 * It depends on {@link AccessTokenVerifier} (bound to the `identity`
 * `TokenService`), not the class -- so `issueAccessToken` never leaves the
 * module, and a consumer module needs only the verifier token in scope.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    @Inject(ACCESS_TOKEN_VERIFIER)
    private readonly verifier: AccessTokenVerifier,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context
      .switchToHttp()
      .getRequest<AuthenticatedRequest>();

    const token = bearerToken(request.headers['authorization']);
    if (token === null) {
      throw new UnauthorizedException({ message: 'Missing bearer token' });
    }

    const { sub, sid } = await this.verifier.verifyAccessToken(token);
    request.userId = sub;
    request.sessionId = sid;
    return true;
  }
}

/** The token from an `Authorization: Bearer <token>` header, or null. */
function bearerToken(
  header: string | string[] | undefined,
): string | null {
  const value = Array.isArray(header) ? header[0] : header;
  if (typeof value !== 'string') {
    return null;
  }
  const match = /^Bearer[ ]+(.+)$/i.exec(value.trim());
  return match ? match[1].trim() : null;
}
