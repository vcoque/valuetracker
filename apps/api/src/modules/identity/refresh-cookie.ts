import { REFRESH_TOKEN_TTL_MS } from './identity.service';

/**
 * The WEB refresh-token cookie (ADR 0003, SPEC-identity.md §"Transport differs
 * per client").
 *
 *  - `HttpOnly`   -> not reachable from JavaScript, so an XSS cannot read it.
 *  - `Secure`     -> HTTPS only.
 *  - `SameSite=Strict` + `Path=/auth/refresh` -> the browser attaches it to
 *    nothing but the refresh call, which removes CSRF exposure from every other
 *    endpoint.
 *  - `Max-Age`    -> matches the session's 30-day absolute expiry.
 *
 * The value is a base64url refresh token (`domain/token.ts`), which needs no
 * percent-encoding in a cookie. Written straight onto the Fastify reply -- the
 * `@fastify/cookie` plugin is only needed to *read* a cookie (Task 10's
 * `/auth/refresh`), not to set one.
 */
export const REFRESH_COOKIE_NAME = 'refresh_token';

export const REFRESH_COOKIE_PATH = '/auth/refresh';

export function serializeRefreshCookie(token: string): string {
  const maxAgeSeconds = Math.floor(REFRESH_TOKEN_TTL_MS / 1000);

  return [
    `${REFRESH_COOKIE_NAME}=${token}`,
    'HttpOnly',
    'Secure',
    'SameSite=Strict',
    `Path=${REFRESH_COOKIE_PATH}`,
    `Max-Age=${maxAgeSeconds}`,
  ].join('; ');
}
