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
 * The plan's acceptance criterion: `GET /currencies` and `GET /exchanges`
 * return the seeded reference data, over the full HTTP stack and a real
 * database. The rows come from the same `seedReferenceData` that `prisma db
 * seed` runs; `integration-setup.ts` truncates between tests, so it runs before
 * each one.
 *
 * Ruling S4: both routes are `Auth: Yes` (`SPEC-catalog.md` §API Surface), so
 * every read needs a Bearer access token from `identity`. The per-IP
 * `RateLimitGuard` is stubbed so the throwaway registrations this suite makes
 * do not trip the limiter.
 */
describe('catalog reference endpoints (e2e)', () => {
  let app: NestFastifyApplication;

  const bearer = async (): Promise<string> => {
    const response = await request(app.getHttpServer())
      .post('/auth/register')
      .send({
        email: `catalog-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`,
        password: 'a-sufficiently-long-password',
        displayName: 'Catalog Reader',
        clientType: 'ANDROID',
      });
    return (response.body as { accessToken: string }).accessToken;
  };

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

  it('GET /currencies rejects a request with no access token (401)', async () => {
    const response = await request(app.getHttpServer()).get('/currencies');

    expect(response.status).toBe(401);
  });

  it('GET /exchanges rejects a request with no access token (401)', async () => {
    const response = await request(app.getHttpServer()).get('/exchanges');

    expect(response.status).toBe(401);
  });

  it('GET /currencies returns the seeded currencies for an authenticated caller', async () => {
    const token = await bearer();

    const response = await request(app.getHttpServer())
      .get('/currencies')
      .set('Authorization', `Bearer ${token}`);

    expect(response.status).toBe(200);
    expect(response.body).toEqual([
      { code: 'BRL', name: 'Brazilian Real', symbol: 'R$', minorUnit: 2 },
      { code: 'EUR', name: 'Euro', symbol: '€', minorUnit: 2 },
      { code: 'USD', name: 'US Dollar', symbol: '$', minorUnit: 2 },
    ]);
  });

  it('GET /exchanges returns the seeded exchanges for an authenticated caller', async () => {
    const token = await bearer();

    const response = await request(app.getHttpServer())
      .get('/exchanges')
      .set('Authorization', `Bearer ${token}`);

    expect(response.status).toBe(200);
    expect(response.body).toEqual([
      {
        code: 'B3',
        name: 'B3 - Brasil, Bolsa, Balcão',
        countryCode: 'BR',
        currencyCode: 'BRL',
        timezone: 'America/Sao_Paulo',
      },
    ]);
  });
});
