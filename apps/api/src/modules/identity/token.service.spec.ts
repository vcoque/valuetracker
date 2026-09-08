import { UnauthorizedException } from '@nestjs/common';
import {
  calculateJwkThumbprint,
  type CryptoKey,
  exportPKCS8,
  generateKeyPair,
  importJWK,
  jwtVerify,
  SignJWT,
} from 'jose';

import { AppConfig } from '../../shared/config/app-config';
import { TokenService } from './token.service';

/**
 * `TokenService` owns the signing key and mints access tokens. This suite drives
 * both key branches (ephemeral for dev, imported PEM for a real deploy), the
 * exact header/claim shape, and a real signature check.
 */
describe('TokenService', () => {
  function config(overrides: Partial<AppConfig> = {}): AppConfig {
    return new AppConfig(
      'postgresql://u:p@localhost:5432/db',
      overrides.nodeEnv ?? 'test',
      overrides.jwtPrivateKey,
      overrides.jwtIssuer ?? 'valuetracker',
      overrides.jwtAudience ?? 'valuetracker-api',
    );
  }

  it('signs a verifiable EdDSA token with an ephemeral key outside production', async () => {
    const service = new TokenService(config());
    await service.onModuleInit();

    const { token } = await service.issueAccessToken({
      userId: 'user-1',
      sessionId: 'session-1',
    });

    const { jwk } = service.getPublicJwk();
    const publicKey = await importJWK(jwk, 'EdDSA');
    const { payload, protectedHeader } = await jwtVerify(token, publicKey, {
      issuer: 'valuetracker',
      audience: 'valuetracker-api',
    });

    const { kid, jwk: publicJwk } = service.getPublicJwk();
    expect(protectedHeader.alg).toBe('EdDSA');
    expect(protectedHeader.kid).toBe(kid);
    // `kid` must be the actual RFC 7638 thumbprint, not just a non-empty
    // string -- Task 10's JWKS lookup keys on it.
    expect(kid).toBe(await calculateJwkThumbprint(publicJwk));
    expect(payload.sub).toBe('user-1');
    expect(payload.sid).toBe('session-1');
  });

  it('emits exactly the six allowed claims in the payload', async () => {
    const service = new TokenService(config());
    await service.onModuleInit();

    const { token } = await service.issueAccessToken({
      userId: 'u',
      sessionId: 's',
    });
    const payload = JSON.parse(
      Buffer.from(token.split('.')[1], 'base64url').toString('utf8'),
    ) as Record<string, unknown>;

    expect(Object.keys(payload).sort()).toEqual([
      'aud',
      'exp',
      'iat',
      'iss',
      'sid',
      'sub',
    ]);
    expect((payload.exp as number) - (payload.iat as number)).toBe(900);
  });

  it('reports a 900-second lifetime for the expiresIn response field', async () => {
    const service = new TokenService(config());
    await service.onModuleInit();

    const { expiresIn } = await service.issueAccessToken({
      userId: 'u',
      sessionId: 's',
    });

    expect(expiresIn).toBe(900);
  });

  it('uses an imported PKCS#8 key when JWT_PRIVATE_KEY is set', async () => {
    const { privateKey } = await generateKeyPair('EdDSA', { extractable: true });
    const pem = await exportPKCS8(privateKey);
    const base64 = Buffer.from(pem, 'utf8').toString('base64');

    const service = new TokenService(
      config({ jwtPrivateKey: base64, nodeEnv: 'production' }),
    );
    await service.onModuleInit();

    const { token } = await service.issueAccessToken({
      userId: 'u',
      sessionId: 's',
    });
    const { jwk } = service.getPublicJwk();
    const publicKey = await importJWK(jwk, 'EdDSA');

    await expect(
      jwtVerify(token, publicKey, {
        issuer: 'valuetracker',
        audience: 'valuetracker-api',
      }),
    ).resolves.toBeDefined();
  });

  it('fails with a static message (no key material) when JWT_PRIVATE_KEY is malformed', async () => {
    const service = new TokenService(
      config({
        jwtPrivateKey: Buffer.from('-----BEGIN PRIVATE KEY-----\nnope\n', 'utf8').toString('base64'),
        nodeEnv: 'production',
      }),
    );

    await expect(service.onModuleInit()).rejects.toThrow(
      'JWT_PRIVATE_KEY is not a valid base64-encoded PKCS#8 Ed25519 private key',
    );
  });

  it('refuses to boot in production with no signing key', async () => {
    const service = new TokenService(config({ nodeEnv: 'production' }));

    await expect(service.onModuleInit()).rejects.toThrow(/JWT_PRIVATE_KEY/);
  });

  /**
   * `verifyAccessToken` is the whole of `AuthGuard`'s work. It must accept a
   * token this service minted and turn EVERY other input -- forged, expired,
   * wrong issuer, malformed -- into a 401, never a 500 (Ruling S12,
   * SPEC-identity.md AC "an expired or revoked session returns 401, never
   * 500"). These run with a KNOWN imported key so a forgery can be signed with
   * the real key where the point is to exercise a claim/`kid` check rather than
   * the signature.
   */
  describe('verifyAccessToken', () => {
    const ISS = 'valuetracker';
    const AUD = 'valuetracker-api';

    let service: TokenService;
    let realKid: string;
    // The real signing key (matches `service`), and a second, unrelated key.
    let realPrivateKey: CryptoKey;
    let otherPrivateKey: CryptoKey;

    const nowSeconds = (): number => Math.floor(Date.now() / 1000);

    /** Sign a payload as this service would: EdDSA, real key, real `kid`. */
    const signWithRealKey = (
      payload: Record<string, unknown>,
      header: Record<string, unknown> = {},
    ): Promise<string> =>
      new SignJWT(payload)
        .setProtectedHeader({ alg: 'EdDSA', kid: realKid, ...header })
        .sign(realPrivateKey);

    const validClaims = (): Record<string, unknown> => ({
      sub: 'user-1',
      sid: 'session-1',
      iat: nowSeconds(),
      exp: nowSeconds() + 900,
      iss: ISS,
      aud: AUD,
    });

    // `UnauthorizedException` is always HTTP 401, so asserting the instance is
    // the whole assertion -- there is no 500 path to distinguish.
    const expectRejected = (token: string): Promise<void> =>
      expect(service.verifyAccessToken(token)).rejects.toBeInstanceOf(
        UnauthorizedException,
      );

    beforeEach(async () => {
      const real = await generateKeyPair('EdDSA', { extractable: true });
      const other = await generateKeyPair('EdDSA', { extractable: true });
      realPrivateKey = real.privateKey;
      otherPrivateKey = other.privateKey;

      const base64 = Buffer.from(
        await exportPKCS8(real.privateKey),
        'utf8',
      ).toString('base64');
      service = new TokenService(
        config({ jwtPrivateKey: base64, nodeEnv: 'production' }),
      );
      await service.onModuleInit();
      realKid = service.getPublicJwk().kid;
    });

    it('accepts a token it just issued and returns sub / sid', async () => {
      const { token } = await service.issueAccessToken({
        userId: 'user-9',
        sessionId: 'session-9',
      });

      await expect(service.verifyAccessToken(token)).resolves.toEqual({
        sub: 'user-9',
        sid: 'session-9',
      });
    });

    it('rejects a garbage string', async () => {
      await expectRejected('not-a-jwt');
      await expectRejected('a.b.c');
    });

    it('rejects an unsigned `alg: none` token forged with the real claims', async () => {
      const header = Buffer.from(
        JSON.stringify({ alg: 'none', kid: realKid }),
        'utf8',
      ).toString('base64url');
      const body = Buffer.from(
        JSON.stringify(validClaims()),
        'utf8',
      ).toString('base64url');

      await expectRejected(`${header}.${body}.`);
    });

    it('rejects a token signed with a different Ed25519 key', async () => {
      const token = await new SignJWT(validClaims())
        .setProtectedHeader({ alg: 'EdDSA', kid: realKid })
        .sign(otherPrivateKey);

      await expectRejected(token);
    });

    it('rejects a token whose `kid` is not the current signing key', async () => {
      const token = await signWithRealKey(validClaims(), { kid: 'unknown-kid' });

      await expectRejected(token);
    });

    it('rejects an expired token even with a valid signature', async () => {
      const token = await signWithRealKey({
        ...validClaims(),
        iat: nowSeconds() - 1000,
        exp: nowSeconds() - 100,
      });

      await expectRejected(token);
    });

    it('rejects a token minted for another issuer or audience', async () => {
      await expectRejected(
        await signWithRealKey({ ...validClaims(), iss: 'evil-issuer' }),
      );
      await expectRejected(
        await signWithRealKey({ ...validClaims(), aud: 'evil-audience' }),
      );
    });

    it('rejects a signature-valid token that is missing `sid`', async () => {
      const { sid: _sid, ...noSid } = validClaims();

      await expectRejected(await signWithRealKey(noSid));
    });
  });
});
