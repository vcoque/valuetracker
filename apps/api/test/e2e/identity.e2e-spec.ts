import { Test } from '@nestjs/testing';
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
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
