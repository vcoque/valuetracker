/**
 * Access-token claims (ADR 0003, SPEC-identity.md §Authentication Design).
 *
 * Pure domain code: no `jose`, no framework, no clock beyond an injectable
 * `now`. Signing lives in `token.service.ts`; this file is the single source of
 * truth for *what* goes in the token, so the "exactly these claims" acceptance
 * criterion is enforced by a type and a unit test rather than by reading the
 * signing code.
 */

/** Access-token lifetime in seconds. 15 minutes (ADR 0003). */
export const ACCESS_TOKEN_TTL_SECONDS = 900;

/**
 * The complete claim set. `sub` and `sid` are the only identifiers; a JWT is
 * readable by anyone holding it, so no email, display name or other personal
 * data appears here (SPEC-identity.md §Claims).
 */
export interface AccessTokenClaims {
  /** Subject: the user id. */
  readonly sub: string;
  /** Session id, for audit and forced-revocation checks. */
  readonly sid: string;
  /** Issued-at, seconds since the epoch. */
  readonly iat: number;
  /** Expiry, seconds since the epoch. Always `iat + ACCESS_TOKEN_TTL_SECONDS`. */
  readonly exp: number;
  /** Issuer. */
  readonly iss: string;
  /** Audience. */
  readonly aud: string;
}

export interface BuildAccessTokenClaimsInput {
  readonly userId: string;
  readonly sessionId: string;
  readonly issuer: string;
  readonly audience: string;
  /** Defaults to the current time. Injectable so the expiry maths is testable. */
  readonly now?: Date;
}

/**
 * Build the claim object to be signed. Returns exactly the six allowed claims
 * and nothing else; `token.service.ts` signs this object verbatim without
 * calling `jose`'s `setIssuedAt` / `setExpirationTime` helpers, so what this
 * function returns is what ends up in the token.
 */
export function buildAccessTokenClaims(
  input: BuildAccessTokenClaimsInput,
): AccessTokenClaims {
  const iat = Math.floor((input.now?.getTime() ?? Date.now()) / 1000);

  return {
    sub: input.userId,
    sid: input.sessionId,
    iat,
    exp: iat + ACCESS_TOKEN_TTL_SECONDS,
    iss: input.issuer,
    aud: input.audience,
  };
}
