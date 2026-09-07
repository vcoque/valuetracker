import { createHash, randomBytes } from 'node:crypto';

/**
 * Refresh-token primitives (SPEC-identity.md §session, ADR 0003).
 *
 * Pure domain code: Node's built-in `crypto` only, no I/O, no framework. The
 * refresh token is opaque server randomness; the `session` row stores only its
 * SHA-256 hash, so a database dump hands over no usable token.
 */

/** Bytes of entropy in a refresh token. 32 bytes = 256 bits (ADR 0003). */
const TOKEN_BYTES = 32;

/**
 * A new refresh token: {@link TOKEN_BYTES} bytes of CSPRNG output, base64url so
 * it is safe in a cookie value, a JSON body and a URL without further encoding.
 * The raw value is returned to the caller once and never stored.
 */
export function generateRefreshToken(): string {
  return randomBytes(TOKEN_BYTES).toString('base64url');
}

/**
 * The value persisted in `session.token_hash` (char(64)): the SHA-256 hex digest
 * of the token. Deterministic, so a presented token can be looked up by hashing
 * it and matching the column.
 *
 * SHA-256 rather than argon2id is deliberate: the token is 256 bits of server
 * randomness, not a human secret, so it is not brute-forcible and a deliberately
 * slow hash would only add latency to every refresh (ADR 0003).
 */
export function hashRefreshToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}
