import { createHash } from 'node:crypto';

import { generateRefreshToken, hashRefreshToken } from './token';

/**
 * Refresh-token generation and hashing (SPEC-identity.md §session). The token is
 * 256 bits of server randomness; it is stored only as a SHA-256 hash, never in
 * the clear. SHA-256 rather than argon2id is deliberate -- a slow hash on a
 * high-entropy value buys nothing and costs latency on every refresh (ADR 0003).
 */
describe('generateRefreshToken', () => {
  it('is base64url that decodes to exactly 32 bytes (256 bits)', () => {
    const token = generateRefreshToken();

    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(Buffer.from(token, 'base64url')).toHaveLength(32);
  });

  it('never repeats across many calls', () => {
    const count = 1_000;
    const tokens = new Set(
      Array.from({ length: count }, () => generateRefreshToken()),
    );

    expect(tokens.size).toBe(count);
  });
});

describe('hashRefreshToken', () => {
  it('is a 64-character lowercase hex string, matching token_hash char(64)', () => {
    expect(hashRefreshToken(generateRefreshToken())).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is deterministic for the same token', () => {
    const token = generateRefreshToken();

    expect(hashRefreshToken(token)).toBe(hashRefreshToken(token));
  });

  it('produces different hashes for different tokens', () => {
    expect(hashRefreshToken('token-a')).not.toBe(hashRefreshToken('token-b'));
  });

  it('does not return the token itself', () => {
    const token = generateRefreshToken();

    expect(hashRefreshToken(token)).not.toBe(token);
  });

  it('is a plain SHA-256 hex digest of the token (known vector)', () => {
    const token = generateRefreshToken();

    expect(hashRefreshToken(token)).toBe(
      createHash('sha256').update(token).digest('hex'),
    );
    expect(hashRefreshToken('valuetracker')).toBe(
      '11c5132051e83496225a6dddeaab2b72229fcd13850e00882afe44aeebe05304',
    );
  });
});
