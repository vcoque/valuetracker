import fastifyCookie from '@fastify/cookie';
import { Test } from '@nestjs/testing';
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import {
  calculateJwkThumbprint,
  type CryptoKey,
  exportJWK,
  exportPKCS8,
  generateKeyPair,
  SignJWT,
} from 'jose';
import request from 'supertest';

import { seedReferenceData } from '../../prisma/seed';
import { AppModule } from '../../src/app.module';
import { RateLimitGuard } from '../../src/shared/http/rate-limit.guard';
import { PrismaService } from '../../src/shared/prisma/prisma.service';

/**
 * `POST /auth/register` and `POST /auth/login` over the full HTTP stack and a
 * real database, for both client types (`SPEC-identity.md` §API Surface,
 * ADR 0003). The per-IP rate-limit guard is stubbed out here: its behaviour is
 * covered by `rate-limit.guard.spec.ts`, and leaving it live would make this
 * suite's repeated calls from one IP flaky.
 */
interface AuthBody {
  accessToken: string;
  tokenType: string;
  expiresIn: number;
  refreshToken?: string;
}

describe('identity auth endpoints (e2e)', () => {
  let app: NestFastifyApplication;

  const password = 'a-sufficiently-long-password';

  const bodyOf = (response: { body: unknown }): AuthBody =>
    response.body as AuthBody;

  const cookiesOf = (response: {
    headers: Record<string, unknown>;
  }): string[] => {
    const raw = response.headers['set-cookie'];
    if (typeof raw === 'string') {
      return [raw];
    }
    return Array.isArray(raw) ? (raw as string[]) : [];
  };

  function decodeJwt(token: string): {
    header: Record<string, unknown>;
    payload: Record<string, unknown>;
  } {
    const [header, payload] = token.split('.');
    return {
      header: JSON.parse(
        Buffer.from(header, 'base64url').toString('utf8'),
      ) as Record<string, unknown>,
      payload: JSON.parse(
        Buffer.from(payload, 'base64url').toString('utf8'),
      ) as Record<string, unknown>,
    };
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideGuard(RateLimitGuard)
      .useValue({ canActivate: () => true })
      .compile();

    app = moduleRef.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter(),
    );
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await seedReferenceData(app.get(PrismaService));
  });

  describe('WEB client', () => {
    it('registers: token in the body, refresh token as a scoped HttpOnly cookie', async () => {
      const response = await request(app.getHttpServer())
        .post('/auth/register')
        .send({
          email: 'web-register@example.com',
          password,
          displayName: 'Web Person',
          clientType: 'WEB',
        });

      expect(response.status).toBe(201);

      const body = bodyOf(response);
      expect(Object.keys(body).sort()).toEqual([
        'accessToken',
        'expiresIn',
        'tokenType',
      ]);
      expect(typeof body.accessToken).toBe('string');
      expect(body.tokenType).toBe('Bearer');
      expect(body.expiresIn).toBe(900);
      expect(body.refreshToken).toBeUndefined();

      const cookies = cookiesOf(response);
      expect(cookies).toHaveLength(1);
      const cookie = cookies[0];
      expect(cookie).toMatch(/^refresh_token=[^;]+/);
      expect(cookie).toContain('HttpOnly');
      expect(cookie).toContain('Secure');
      expect(cookie).toContain('SameSite=Strict');
      expect(cookie).toContain('Path=/auth/refresh');
      expect(cookie).toContain('Max-Age=2592000');
    });

    it('logs in: same shape, refresh token stays in the cookie', async () => {
      await request(app.getHttpServer()).post('/auth/register').send({
        email: 'web-login@example.com',
        password,
        displayName: 'Web Person',
        clientType: 'WEB',
      });

      const response = await request(app.getHttpServer())
        .post('/auth/login')
        .send({ email: 'web-login@example.com', password, clientType: 'WEB' });

      expect(response.status).toBe(200);

      const body = bodyOf(response);
      expect(typeof body.accessToken).toBe('string');
      expect(body.tokenType).toBe('Bearer');
      expect(body.expiresIn).toBe(900);
      expect(body.refreshToken).toBeUndefined();
      expect(cookiesOf(response)[0]).toContain('Path=/auth/refresh');
    });
  });

  describe('ANDROID client', () => {
    it('registers: both tokens in the body, no cookie', async () => {
      const response = await request(app.getHttpServer())
        .post('/auth/register')
        .send({
          email: 'android-register@example.com',
          password,
          displayName: 'Android Person',
          clientType: 'ANDROID',
        });

      expect(response.status).toBe(201);

      const body = bodyOf(response);
      expect(Object.keys(body).sort()).toEqual([
        'accessToken',
        'expiresIn',
        'refreshToken',
        'tokenType',
      ]);
      expect(typeof body.accessToken).toBe('string');
      expect(typeof body.refreshToken).toBe('string');
      expect((body.refreshToken ?? '').length).toBeGreaterThan(0);
      expect(cookiesOf(response)).toHaveLength(0);
    });

    it('logs in: both tokens in the body, no cookie', async () => {
      await request(app.getHttpServer()).post('/auth/register').send({
        email: 'android-login@example.com',
        password,
        displayName: 'Android Person',
        clientType: 'ANDROID',
      });

      const response = await request(app.getHttpServer())
        .post('/auth/login')
        .send({
          email: 'android-login@example.com',
          password,
          clientType: 'ANDROID',
        });

      expect(response.status).toBe(200);
      expect(typeof bodyOf(response).refreshToken).toBe('string');
      expect(cookiesOf(response)).toHaveLength(0);
    });
  });

  it('issues an EdDSA access token carrying exactly the six allowed claims', async () => {
    const response = await request(app.getHttpServer())
      .post('/auth/register')
      .send({
        email: 'claims@example.com',
        password,
        displayName: 'Claims Person',
        clientType: 'ANDROID',
      });

    const { header, payload } = decodeJwt(bodyOf(response).accessToken);

    expect(Object.keys(header).sort()).toEqual(['alg', 'kid']);
    expect(header.alg).toBe('EdDSA');
    expect(typeof header.kid).toBe('string');
    expect((header.kid as string).length).toBeGreaterThan(0);

    expect(Object.keys(payload).sort()).toEqual([
      'aud',
      'exp',
      'iat',
      'iss',
      'sid',
      'sub',
    ]);
    expect((payload.exp as number) - (payload.iat as number)).toBe(900);
    expect(payload.iss).toBe('valuetracker');
    expect(payload.aud).toBe('valuetracker-api');
  });

  it('rejects a malformed body with 400 and no echo of the password', async () => {
    const response = await request(app.getHttpServer())
      .post('/auth/register')
      .send({
        email: 'not-an-email',
        password: 'short',
        displayName: 'X',
        clientType: 'WEB',
      });

    expect(response.status).toBe(400);
    expect(JSON.stringify(response.body)).not.toContain('short');
  });

  it('rejects a syntactically valid but unseeded base currency code with 400', async () => {
    const response = await request(app.getHttpServer())
      .post('/auth/register')
      .send({
        email: 'gbp@example.com',
        password,
        displayName: 'Sterling Person',
        baseCurrencyCode: 'GBP', // valid /^[A-Z]{3}$/, but only BRL/USD/EUR are seeded
        clientType: 'WEB',
      });

    expect(response.status).toBe(400);
    expect(JSON.stringify(response.body)).toContain('Unknown base currency code');
  });

  it('sets Cache-Control: no-store on a token-bearing response', async () => {
    const response = await request(app.getHttpServer())
      .post('/auth/register')
      .send({
        email: 'nostore@example.com',
        password,
        displayName: 'No Store Person',
        clientType: 'ANDROID',
      });

    expect(response.status).toBe(201);
    expect(response.headers['cache-control']).toBe('no-store');
  });

  it('returns the same generic 401 for a wrong password and an unknown email', async () => {
    await request(app.getHttpServer()).post('/auth/register').send({
      email: 'real@example.com',
      password,
      displayName: 'Real Person',
      clientType: 'WEB',
    });

    const wrongPassword = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: 'real@example.com', password: 'wrong-password-value' });
    const unknownEmail = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: 'ghost@example.com', password });

    expect(wrongPassword.status).toBe(401);
    expect(unknownEmail.status).toBe(401);
    expect(wrongPassword.body).toEqual(unknownEmail.body);
  });

  it('returns a generic 409 with no email echo for a duplicate registration', async () => {
    const body = {
      email: 'twice@example.com',
      password,
      displayName: 'Twice Person',
      clientType: 'WEB' as const,
    };
    await request(app.getHttpServer()).post('/auth/register').send(body);

    const response = await request(app.getHttpServer())
      .post('/auth/register')
      .send(body);

    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({
      message: 'Registration could not be completed',
    });
    expect(JSON.stringify(response.body)).not.toContain('twice@example.com');
  });
});

/**
 * The per-IP `RateLimitGuard` is left LIVE here (no `.overrideGuard`) so this
 * proves the guard is actually wired to `/auth/register` -- a dropped
 * `@UseGuards`, a mis-typed `RATE_LIMIT_METADATA` key or a bad decorator order
 * would make every other test still pass while the auth routes ran unlimited
 * (`SPEC-identity.md` AC: "rate-limited per IP … first-slice, not hardening").
 */
describe('identity auth endpoints — rate limiting (e2e)', () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter(),
    );
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    // `integration-setup.ts` truncates every table before each test.
    await seedReferenceData(app.get(PrismaService));
  });

  it('answers 429 once /auth/register is hit past its per-IP limit', async () => {
    // Configured limit is 5 / IP / 60s; the 6th call from this client is over.
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) {
      const response = await request(app.getHttpServer())
        .post('/auth/register')
        .send({
          email: `flood-${i}@example.com`,
          password: 'a-sufficiently-long-password',
          displayName: `Flood ${i}`,
          clientType: 'ANDROID',
        });
      statuses.push(response.status);
    }

    expect(statuses.slice(0, 5)).toEqual([201, 201, 201, 201, 201]);
    expect(statuses[5]).toBe(429);
  });
});

/**
 * `AuthGuard`, `/auth/refresh` rotation + reuse detection, `/auth/logout(-all)`,
 * `/auth/me` and `/auth/sessions` over the full HTTP stack (`SPEC-identity.md`
 * §API Surface, ADR 0003). The per-IP `RateLimitGuard` is stubbed -- its wiring
 * is proven by the block above.
 *
 * A KNOWN Ed25519 signing key is injected via `JWT_PRIVATE_KEY` so the guard's
 * forgery-rejection paths can be exercised with tokens this test signs itself:
 * one per forgery (`alg: none`, wrong key, unknown `kid`) plus an expired one.
 */
describe('identity auth guard, refresh, profile (e2e)', () => {
  let app: NestFastifyApplication;
  let prisma: PrismaService;

  const password = 'a-sufficiently-long-password';

  /** The real signing key (matches the running app) and an unrelated one. */
  let realPrivateKey: CryptoKey;
  let otherPrivateKey: CryptoKey;
  let realKid: string;

  interface Body {
    accessToken: string;
    tokenType: string;
    expiresIn: number;
    refreshToken?: string;
  }

  const setCookies = (res: {
    headers: Record<string, unknown>;
  }): string[] => {
    const raw = res.headers['set-cookie'];
    if (typeof raw === 'string') return [raw];
    return Array.isArray(raw) ? (raw as string[]) : [];
  };

  const refreshCookieValue = (res: {
    headers: Record<string, unknown>;
  }): string => {
    const cookie = setCookies(res).find((c) => c.startsWith('refresh_token='));
    if (!cookie) throw new Error('no refresh_token cookie on response');
    return /refresh_token=([^;]*)/.exec(cookie)?.[1] ?? '';
  };

  const sidOf = (accessToken: string): string =>
    (
      JSON.parse(
        Buffer.from(accessToken.split('.')[1], 'base64url').toString('utf8'),
      ) as { sid: string }
    ).sid;

  const uniqueEmail = (tag: string): string =>
    `${tag}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;

  const register = (
    clientType: 'WEB' | 'ANDROID',
    email = uniqueEmail(clientType.toLowerCase()),
  ) =>
    request(app.getHttpServer())
      .post('/auth/register')
      .send({ email, password, displayName: 'Guarded Person', clientType });

  const claims = (overrides: Record<string, unknown> = {}): Record<
    string,
    unknown
  > => {
    const iat = Math.floor(Date.now() / 1000);
    return {
      sub: 'forged-user',
      sid: 'forged-session',
      iat,
      exp: iat + 900,
      iss: 'valuetracker',
      aud: 'valuetracker-api',
      ...overrides,
    };
  };

  const signReal = (
    payload: Record<string, unknown>,
    header: Record<string, unknown> = {},
  ): Promise<string> =>
    new SignJWT(payload)
      .setProtectedHeader({ alg: 'EdDSA', kid: realKid, ...header })
      .sign(realPrivateKey);

  beforeAll(async () => {
    const real = await generateKeyPair('EdDSA', { extractable: true });
    const other = await generateKeyPair('EdDSA', { extractable: true });
    realPrivateKey = real.privateKey;
    otherPrivateKey = other.privateKey;
    realKid = await calculateJwkThumbprint(await exportJWK(real.publicKey));

    process.env.JWT_PRIVATE_KEY = Buffer.from(
      await exportPKCS8(real.privateKey),
      'utf8',
    ).toString('base64');

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideGuard(RateLimitGuard)
      .useValue({ canActivate: () => true })
      .compile();

    app = moduleRef.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter(),
    );
    await app.register(fastifyCookie);
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    await app.close();
    delete process.env.JWT_PRIVATE_KEY;
  });

  beforeEach(async () => {
    await seedReferenceData(prisma);
  });

  describe('AuthGuard rejections', () => {
    it('401 with no Authorization header', async () => {
      const res = await request(app.getHttpServer()).get('/auth/me');
      expect(res.status).toBe(401);
    });

    it('401 with a malformed Authorization header', async () => {
      const res = await request(app.getHttpServer())
        .get('/auth/me')
        .set('Authorization', 'Token abc.def.ghi');
      expect(res.status).toBe(401);
    });

    it('401 with a structurally-valid but garbage bearer token', async () => {
      const res = await request(app.getHttpServer())
        .get('/auth/me')
        .set('Authorization', 'Bearer not-a-real-jwt');
      expect(res.status).toBe(401);
    });

    it('401 for a token forged with alg:none', async () => {
      const header = Buffer.from(
        JSON.stringify({ alg: 'none', kid: realKid }),
        'utf8',
      ).toString('base64url');
      const body = Buffer.from(JSON.stringify(claims()), 'utf8').toString(
        'base64url',
      );

      const res = await request(app.getHttpServer())
        .get('/auth/me')
        .set('Authorization', `Bearer ${header}.${body}.`);
      expect(res.status).toBe(401);
    });

    it('401 for a token signed with a different Ed25519 key', async () => {
      const token = await new SignJWT(claims())
        .setProtectedHeader({ alg: 'EdDSA', kid: realKid })
        .sign(otherPrivateKey);

      const res = await request(app.getHttpServer())
        .get('/auth/me')
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(401);
    });

    it('401 for a token carrying an unknown kid', async () => {
      const token = await signReal(claims(), { kid: 'unknown-kid-999' });

      const res = await request(app.getHttpServer())
        .get('/auth/me')
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(401);
    });

    it('401 for an expired token with an otherwise-valid signature', async () => {
      const iat = Math.floor(Date.now() / 1000) - 1000;
      const token = await signReal(claims({ iat, exp: iat + 100 }));

      const res = await request(app.getHttpServer())
        .get('/auth/me')
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(401);
    });
  });

  describe('GET/PATCH /auth/me', () => {
    it('returns only the caller record, with no password hash', async () => {
      const email = uniqueEmail('me');
      const reg = await register('ANDROID', email);
      const token = (reg.body as Body).accessToken;

      const res = await request(app.getHttpServer())
        .get('/auth/me')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(Object.keys(res.body as object).sort()).toEqual([
        'baseCurrencyCode',
        'createdAt',
        'displayName',
        'email',
        'id',
        'timezone',
      ]);
      expect((res.body as { email: string }).email).toBe(email);
      expect(JSON.stringify(res.body)).not.toMatch(/argon2|passwordHash|hash/i);
    });

    it('updates displayName, baseCurrencyCode and timezone', async () => {
      const reg = await register('ANDROID');
      const token = (reg.body as Body).accessToken;

      const patch = await request(app.getHttpServer())
        .patch('/auth/me')
        .set('Authorization', `Bearer ${token}`)
        .send({
          displayName: 'Renamed',
          baseCurrencyCode: 'USD',
          timezone: 'America/Sao_Paulo',
        });

      expect(patch.status).toBe(200);
      expect(patch.body).toMatchObject({
        displayName: 'Renamed',
        baseCurrencyCode: 'USD',
        timezone: 'America/Sao_Paulo',
      });

      const after = await request(app.getHttpServer())
        .get('/auth/me')
        .set('Authorization', `Bearer ${token}`);
      expect(after.body).toMatchObject({
        displayName: 'Renamed',
        baseCurrencyCode: 'USD',
      });
    });

    it('rejects an unknown field with 400', async () => {
      const reg = await register('ANDROID');
      const token = (reg.body as Body).accessToken;

      const res = await request(app.getHttpServer())
        .patch('/auth/me')
        .set('Authorization', `Bearer ${token}`)
        .send({ email: 'moved@example.com' });

      expect(res.status).toBe(400);
    });

    it('rejects an empty patch with 400', async () => {
      const reg = await register('ANDROID');
      const token = (reg.body as Body).accessToken;

      const res = await request(app.getHttpServer())
        .patch('/auth/me')
        .set('Authorization', `Bearer ${token}`)
        .send({});

      expect(res.status).toBe(400);
    });

    it('rejects an unseeded baseCurrencyCode with 400, not 500', async () => {
      const reg = await register('ANDROID');
      const token = (reg.body as Body).accessToken;

      const res = await request(app.getHttpServer())
        .patch('/auth/me')
        .set('Authorization', `Bearer ${token}`)
        .send({ baseCurrencyCode: 'GBP' });

      expect(res.status).toBe(400);
      expect(JSON.stringify(res.body)).toContain('Unknown base currency code');
    });
  });

  describe('GET /auth/sessions', () => {
    it('lists the caller sessions with `current` set on the calling one', async () => {
      const email = uniqueEmail('sessions');
      const reg = await register('ANDROID', email);
      const firstToken = (reg.body as Body).accessToken;

      const second = await request(app.getHttpServer())
        .post('/auth/login')
        .send({ email, password, clientType: 'ANDROID' });
      expect(second.status).toBe(200);

      const res = await request(app.getHttpServer())
        .get('/auth/sessions')
        .set('Authorization', `Bearer ${firstToken}`);

      expect(res.status).toBe(200);
      const rows = res.body as { id: string; current: boolean }[];
      expect(rows).toHaveLength(2);
      expect(rows.filter((r) => r.current)).toHaveLength(1);
      expect(rows.find((r) => r.current)?.id).toBe(sidOf(firstToken));
    });
  });

  describe('POST /auth/refresh — rotation and reuse detection', () => {
    it('ANDROID: rotates, old token 401s, new token keeps working', async () => {
      const reg = await register('ANDROID');
      const r1 = (reg.body as Body).refreshToken as string;

      const rot = await request(app.getHttpServer())
        .post('/auth/refresh')
        .send({ refreshToken: r1, clientType: 'ANDROID' });
      expect(rot.status).toBe(200);
      const r2 = (rot.body as Body).refreshToken as string;
      expect(r2).toBeDefined();
      expect(r2).not.toBe(r1);

      const again = await request(app.getHttpServer())
        .post('/auth/refresh')
        .send({ refreshToken: r2, clientType: 'ANDROID' });
      expect(again.status).toBe(200);

      const replay = await request(app.getHttpServer())
        .post('/auth/refresh')
        .send({ refreshToken: r1, clientType: 'ANDROID' });
      expect(replay.status).toBe(401);
    });

    it('ANDROID: replaying a rotated token kills the whole chain', async () => {
      const reg = await register('ANDROID');
      const r1 = (reg.body as Body).refreshToken as string;

      const rot = await request(app.getHttpServer())
        .post('/auth/refresh')
        .send({ refreshToken: r1, clientType: 'ANDROID' });
      const r2 = (rot.body as Body).refreshToken as string;

      const replay = await request(app.getHttpServer())
        .post('/auth/refresh')
        .send({ refreshToken: r1, clientType: 'ANDROID' });
      expect(replay.status).toBe(401);

      const r2AfterReuse = await request(app.getHttpServer())
        .post('/auth/refresh')
        .send({ refreshToken: r2, clientType: 'ANDROID' });
      expect(r2AfterReuse.status).toBe(401);
    });

    it('WEB: rotates via the refresh_token cookie and re-sets it', async () => {
      const reg = await register('WEB');
      const c1 = refreshCookieValue(reg);

      const rot = await request(app.getHttpServer())
        .post('/auth/refresh')
        .set('Cookie', `refresh_token=${c1}`)
        .send({});
      expect(rot.status).toBe(200);
      expect((rot.body as Body).refreshToken).toBeUndefined();
      const setCookie = setCookies(rot).find((c) =>
        c.startsWith('refresh_token='),
      );
      expect(setCookie).toContain('Path=/auth/refresh');
      expect(refreshCookieValue(rot)).not.toBe(c1);

      const replay = await request(app.getHttpServer())
        .post('/auth/refresh')
        .set('Cookie', `refresh_token=${c1}`)
        .send({});
      expect(replay.status).toBe(401);
    });

    it('401 when a WEB refresh arrives with no cookie', async () => {
      const res = await request(app.getHttpServer())
        .post('/auth/refresh')
        .send({});
      expect(res.status).toBe(401);
    });
  });

  describe('POST /auth/logout and /auth/logout-all', () => {
    it('logout revokes the caller session: its refresh token then 401s', async () => {
      const reg = await register('ANDROID');
      const token = (reg.body as Body).accessToken;
      const refreshToken = (reg.body as Body).refreshToken as string;

      const out = await request(app.getHttpServer())
        .post('/auth/logout')
        .set('Authorization', `Bearer ${token}`)
        .send();
      expect(out.status).toBe(204);

      const refresh = await request(app.getHttpServer())
        .post('/auth/refresh')
        .send({ refreshToken, clientType: 'ANDROID' });
      expect(refresh.status).toBe(401);
    });

    it('logout on a WEB session clears the cookie', async () => {
      const reg = await register('WEB');
      const token = (reg.body as Body).accessToken;

      const out = await request(app.getHttpServer())
        .post('/auth/logout')
        .set('Authorization', `Bearer ${token}`)
        .send();

      expect(out.status).toBe(204);
      const cleared = setCookies(out).find((c) =>
        c.startsWith('refresh_token='),
      );
      expect(cleared).toContain('Max-Age=0');
      expect(cleared).toContain('Path=/auth/refresh');
    });

    it('logout-all kills a second device: its refresh token 401s', async () => {
      const email = uniqueEmail('logoutall');
      const device1 = await register('ANDROID', email);
      const a1 = (device1.body as Body).accessToken;

      const device2 = await request(app.getHttpServer())
        .post('/auth/login')
        .send({ email, password, clientType: 'ANDROID' });
      const r2 = (device2.body as Body).refreshToken as string;

      const out = await request(app.getHttpServer())
        .post('/auth/logout-all')
        .set('Authorization', `Bearer ${a1}`)
        .send();
      expect(out.status).toBe(204);

      const refresh = await request(app.getHttpServer())
        .post('/auth/refresh')
        .send({ refreshToken: r2, clientType: 'ANDROID' });
      expect(refresh.status).toBe(401);
    });
  });
});
