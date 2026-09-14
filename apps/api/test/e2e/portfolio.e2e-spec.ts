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

  it('updates the mutable fields via PATCH and rejects a change to base_currency_code or user_id (Task 12)', async () => {
    const server = app.getHttpServer();
    const token = await register();

    const createResponse = await request(server)
      .post('/portfolios')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Immutable Currency', baseCurrencyCode: 'BRL' });
    const portfolioId = (createResponse.body as { id: string }).id;

    // base_currency_code and user_id are not fields of updatePortfolioRequestSchema
    // at all -- `.strict()` makes either one an unrecognized key (400), not a
    // silently-ignored one. `SPEC-portfolio.md`: base_currency_code is
    // immutable after creation.
    const patchCurrency = await request(server)
      .patch(`/portfolios/${portfolioId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ baseCurrencyCode: 'USD' });
    expect(patchCurrency.status).toBe(400);

    const patchUserId = await request(server)
      .patch(`/portfolios/${portfolioId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ userId: 'not-the-real-owner' });
    expect(patchUserId.status).toBe(400);

    // A direct DB read confirms the rejected PATCHes changed nothing.
    const untouched = await app
      .get(PrismaService)
      .portfolio.findUniqueOrThrow({ where: { id: portfolioId } });
    expect(untouched.baseCurrencyCode).toBe('BRL');
    expect(untouched.userId).not.toBe('not-the-real-owner');

    const patchMutable = await request(server)
      .patch(`/portfolios/${portfolioId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({
        name: 'Renamed Portfolio',
        description: 'updated description',
        objective: 'updated objective',
        targetAmount: '999.5000',
        targetDate: '2050-01-01',
      });
    expect(patchMutable.status).toBe(200);
    expect(patchMutable.body).toMatchObject({
      id: portfolioId,
      name: 'Renamed Portfolio',
      description: 'updated description',
      objective: 'updated objective',
      baseCurrencyCode: 'BRL',
      targetAmount: '999.5000',
      targetDate: '2050-01-01',
    });

    const getAfterPatch = await request(server)
      .get(`/portfolios/${portfolioId}`)
      .set('Authorization', `Bearer ${token}`);
    expect(getAfterPatch.body).toEqual(patchMutable.body);
  });

  it('rejects a duplicate (user_id, name) via PATCH-rename with a 409; a different user may use the same name', async () => {
    const server = app.getHttpServer();
    const tokenA = await register();
    const tokenB = await register();

    const createRetirement = await request(server)
      .post('/portfolios')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ name: 'Retirement', baseCurrencyCode: 'BRL' });
    expect(createRetirement.status).toBe(201);

    const duplicateCreate = await request(server)
      .post('/portfolios')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ name: 'Retirement', baseCurrencyCode: 'BRL' });
    expect(duplicateCreate.status).toBe(409);

    const createVacation = await request(server)
      .post('/portfolios')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ name: 'Vacation', baseCurrencyCode: 'BRL' });
    const vacationId = (createVacation.body as { id: string }).id;

    const renameToDuplicate = await request(server)
      .patch(`/portfolios/${vacationId}`)
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ name: 'Retirement' });
    expect(renameToDuplicate.status).toBe(409);

    // The same name for a DIFFERENT user is unaffected -- the constraint is
    // composite on (user_id, name), not on name alone.
    const otherUserSameName = await request(server)
      .post('/portfolios')
      .set('Authorization', `Bearer ${tokenB}`)
      .send({ name: 'Retirement', baseCurrencyCode: 'BRL' });
    expect(otherUserSameName.status).toBe(201);
  });

  it('archives a portfolio out of the default list and unarchive restores it (Task 12)', async () => {
    const server = app.getHttpServer();
    const token = await register();

    const create = await request(server)
      .post('/portfolios')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'To Archive', baseCurrencyCode: 'BRL' });
    const id = (create.body as { id: string }).id;

    const archiveResponse = await request(server)
      .post(`/portfolios/${id}/archive`)
      .set('Authorization', `Bearer ${token}`)
      .send();
    expect(archiveResponse.status).toBe(200);
    expect((archiveResponse.body as { id: string }).id).toBe(id);

    const defaultListAfterArchive = await request(server)
      .get('/portfolios')
      .set('Authorization', `Bearer ${token}`);
    expect(defaultListAfterArchive.body).toEqual([]);

    const includeArchivedList = await request(server)
      .get('/portfolios?includeArchived=true')
      .set('Authorization', `Bearer ${token}`);
    expect((includeArchivedList.body as { id: string }[]).map((p) => p.id)).toEqual([
      id,
    ]);

    // Design decision (Task 12): the single-get is consistent with
    // `?includeArchived=true` and does not hide an archived portfolio.
    const getArchived = await request(server)
      .get(`/portfolios/${id}`)
      .set('Authorization', `Bearer ${token}`);
    expect(getArchived.status).toBe(200);

    const unarchiveResponse = await request(server)
      .post(`/portfolios/${id}/unarchive`)
      .set('Authorization', `Bearer ${token}`)
      .send();
    expect(unarchiveResponse.status).toBe(200);

    const defaultListAfterUnarchive = await request(server)
      .get('/portfolios')
      .set('Authorization', `Bearer ${token}`);
    expect(
      (defaultListAfterUnarchive.body as { id: string }[]).map((p) => p.id),
    ).toEqual([id]);
  });

  it('404s on PATCH, archive and unarchive for a portfolio owned by another user', async () => {
    const server = app.getHttpServer();
    const tokenA = await register();
    const tokenB = await register();

    const create = await request(server)
      .post('/portfolios')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ name: 'Owned By A', baseCurrencyCode: 'BRL' });
    const id = (create.body as { id: string }).id;

    const patchAsB = await request(server)
      .patch(`/portfolios/${id}`)
      .set('Authorization', `Bearer ${tokenB}`)
      .send({ name: 'Hijacked' });
    expect(patchAsB.status).toBe(404);

    const archiveAsB = await request(server)
      .post(`/portfolios/${id}/archive`)
      .set('Authorization', `Bearer ${tokenB}`)
      .send();
    expect(archiveAsB.status).toBe(404);

    const unarchiveAsB = await request(server)
      .post(`/portfolios/${id}/unarchive`)
      .set('Authorization', `Bearer ${tokenB}`)
      .send();
    expect(unarchiveAsB.status).toBe(404);

    // Confirm A's portfolio is untouched -- still active, still named "Owned By A".
    const getAsA = await request(server)
      .get(`/portfolios/${id}`)
      .set('Authorization', `Bearer ${tokenA}`);
    expect(getAsA.body).toMatchObject({ name: 'Owned By A' });
  });

  it('has no DELETE route (archive is the only removal path)', async () => {
    const server = app.getHttpServer();
    const token = await register();

    const create = await request(server)
      .post('/portfolios')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'No Delete Route', baseCurrencyCode: 'BRL' });
    const id = (create.body as { id: string }).id;

    const deleteResponse = await request(server)
      .delete(`/portfolios/${id}`)
      .set('Authorization', `Bearer ${token}`);
    // No @Delete handler is registered on the controller -- Fastify/Nest
    // reports this the same way it reports any unmatched route, 404.
    expect(deleteResponse.status).toBe(404);

    const stillThere = await request(server)
      .get(`/portfolios/${id}`)
      .set('Authorization', `Bearer ${token}`);
    expect(stillThere.status).toBe(200);
  });
});
