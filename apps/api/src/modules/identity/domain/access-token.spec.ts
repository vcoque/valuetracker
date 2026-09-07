import {
  ACCESS_TOKEN_TTL_SECONDS,
  buildAccessTokenClaims,
} from './access-token';

/**
 * The access token carries EXACTLY `sub`, `sid`, `iat`, `exp`, `iss`, `aud`
 * (SPEC-identity.md §Claims). This suite pins that claim set and the expiry
 * maths; `token.service.ts` signs whatever this builder returns.
 */
describe('buildAccessTokenClaims', () => {
  const base = {
    userId: 'user-uuid',
    sessionId: 'session-uuid',
    issuer: 'valuetracker',
    audience: 'valuetracker-api',
  };

  it('emits exactly the six allowed claims and nothing else', () => {
    const claims = buildAccessTokenClaims(base);

    expect(Object.keys(claims).sort()).toEqual([
      'aud',
      'exp',
      'iat',
      'iss',
      'sid',
      'sub',
    ]);
  });

  it('maps sub to the user id and sid to the session id', () => {
    const claims = buildAccessTokenClaims(base);

    expect(claims.sub).toBe('user-uuid');
    expect(claims.sid).toBe('session-uuid');
  });

  it('sets exp exactly 900 seconds after iat', () => {
    const claims = buildAccessTokenClaims(base);

    expect(claims.exp - claims.iat).toBe(900);
    expect(claims.exp - claims.iat).toBe(ACCESS_TOKEN_TTL_SECONDS);
  });

  it('derives iat from the injected clock, in whole seconds', () => {
    const now = new Date('2026-09-07T12:00:00.500Z');

    const claims = buildAccessTokenClaims({ ...base, now });

    expect(claims.iat).toBe(Math.floor(now.getTime() / 1000));
    expect(Number.isInteger(claims.iat)).toBe(true);
  });

  it('passes issuer and audience through verbatim', () => {
    const claims = buildAccessTokenClaims({
      ...base,
      issuer: 'iss-x',
      audience: 'aud-y',
    });

    expect(claims.iss).toBe('iss-x');
    expect(claims.aud).toBe('aud-y');
  });
});
