import {
  calculateJwkThumbprint,
  generateKeyPair,
  exportPKCS8,
  importJWK,
  jwtVerify,
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
});
