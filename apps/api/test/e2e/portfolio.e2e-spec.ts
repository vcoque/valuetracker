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
 * The walking-skeleton slice for `portfolio` (`SPEC-portfolio.md`
 * §Verification): a user creates a portfolio and sees it in their own list;
 * another user gets an empty list and a 404 on the first user's id -- ids
 * must not be enumerable. `RateLimitGuard` is stubbed so the throwaway
 * registrations this suite makes do not trip the per-IP limiter (mirrors
 * `catalog.e2e-spec.ts`).
 */
describe('portfolio endpoints (e2e)', () => {
  let app: NestFastifyApplication;

  const register = async (): Promise<string> => {
    const response = await request(app.getHttpServer())
      .post('/auth/register')
      .send({
        email: `portfolio-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`,
        password: 'a-sufficiently-long-password',
        displayName: 'Portfolio Owner',
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

  it('rejects every route with no access token (401)', async () => {
    const server = app.getHttpServer();

    expect((await request(server).get('/portfolios')).status).toBe(401);
    expect(
      (await request(server).get(`/portfolios/${'0'.repeat(8)}-0000-0000-0000-000000000000`)).status,
    ).toBe(401);
    expect(
      (await request(server).post('/portfolios').send({ name: 'x', baseCurrencyCode: 'BRL' }))
        .status,
    ).toBe(401);
  });

  it('creates a portfolio, lists it back, and enforces ownership isolation for another user', async () => {
    const server = app.getHttpServer();
    const tokenA = await register();

    const createResponse = await request(server)
      .post('/portfolios')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({
        name: 'Retirement',
        description: 'Long-term savings',
        objective: 'buy a house in 10 years',
        baseCurrencyCode: 'BRL',
        targetAmount: '250000.00',
        targetDate: '2040-01-01',
      });

    expect(createResponse.status).toBe(201);
    expect(createResponse.body).toMatchObject({
      name: 'Retirement',
      description: 'Long-term savings',
      objective: 'buy a house in 10 years',
      baseCurrencyCode: 'BRL',
      targetAmount: '250000.0000',
      targetDate: '2040-01-01',
    });
    const portfolioId = (createResponse.body as { id: string }).id;
    expect(portfolioId).toEqual(expect.any(String));

    const listAsA = await request(server)
      .get('/portfolios')
      .set('Authorization', `Bearer ${tokenA}`);
    expect(listAsA.status).toBe(200);
    expect(listAsA.body).toEqual([createResponse.body]);

    const getAsA = await request(server)
      .get(`/portfolios/${portfolioId}`)
      .set('Authorization', `Bearer ${tokenA}`);
    expect(getAsA.status).toBe(200);
    expect(getAsA.body).toEqual(createResponse.body);

    const tokenB = await register();

    const listAsB = await request(server)
      .get('/portfolios')
      .set('Authorization', `Bearer ${tokenB}`);
    expect(listAsB.status).toBe(200);
    expect(listAsB.body).toEqual([]);

    const getAsB = await request(server)
      .get(`/portfolios/${portfolioId}`)
      .set('Authorization', `Bearer ${tokenB}`);
    expect(getAsB.status).toBe(404);
  });

  it('rejects a negative target_amount with a 400', async () => {
    const token = await register();

    const response = await request(app.getHttpServer())
      .post('/portfolios')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Bad Amount', baseCurrencyCode: 'BRL', targetAmount: '-1' });

    expect(response.status).toBe(400);
  });

  it('rejects an unknown base_currency_code with a 400', async () => {
    const token = await register();

    const response = await request(app.getHttpServer())
      .post('/portfolios')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Unknown Currency', baseCurrencyCode: 'ZZZ' });

    expect(response.status).toBe(400);
  });
});
