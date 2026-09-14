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
 * The walking-skeleton proof (`SPEC-portfolio.md` §Verification, verbatim):
 *
 *   register user A -> login -> create portfolio "Retirement" (BRL)
 *                             -> create a private CDB instrument
 *                             -> GET /portfolios returns exactly that portfolio
 *   register user B -> login -> GET /portfolios returns []
 *                             -> GET /portfolios/<A's id> returns 404
 *                             -> GET /instruments does not list A's CDB
 *
 * When this passes, `identity` + `catalog` + `portfolio` are proven together
 * over real HTTP against a real Postgres, using nothing but each module's own
 * already-tested endpoints. This is the one cross-module proof -- every
 * individual endpoint's edge cases are already covered by `identity.e2e-spec`,
 * `portfolio.e2e-spec` and `instrument.e2e-spec`, so this file stays to just
 * the one flow the spec names. `RateLimitGuard` is stubbed out, matching
 * those other e2e suites (its own behaviour is covered by
 * `rate-limit.guard.spec.ts`).
 */
describe('walking skeleton: identity + catalog + portfolio (e2e)', () => {
  let app: NestFastifyApplication;

  const password = 'a-sufficiently-long-password';

  interface AuthBody {
    accessToken: string;
  }

  const register = (
    email: string,
    displayName: string,
  ): Promise<request.Response> =>
    request(app.getHttpServer())
      .post('/auth/register')
      .send({ email, password, displayName, clientType: 'ANDROID' });

  const login = (email: string): Promise<request.Response> =>
    request(app.getHttpServer())
      .post('/auth/login')
      .send({ email, password, clientType: 'ANDROID' });

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

  it('proves the identity + catalog + portfolio slice end to end', async () => {
    const server = app.getHttpServer();
    const emailA = `walking-a-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
    const emailB = `walking-b-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;

    // -- register user A, then log in (both leave the endpoint working) --
    const registerA = await register(emailA, 'Walker A');
    expect(registerA.status).toBe(201);

    const loginA = await login(emailA);
    expect(loginA.status).toBe(200);
    const tokenA = (loginA.body as AuthBody).accessToken;

    // -- A creates the "Retirement" (BRL) portfolio --
    const createPortfolio = await request(server)
      .post('/portfolios')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ name: 'Retirement', baseCurrencyCode: 'BRL' });
    expect(createPortfolio.status).toBe(201);
    expect(createPortfolio.body).toMatchObject({
      name: 'Retirement',
      baseCurrencyCode: 'BRL',
    });
    const portfolioId = (createPortfolio.body as { id: string }).id;

    // -- A creates a private CDB instrument --
    const createCdb = await request(server)
      .post('/instruments')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({
        name: 'Banco X CDB 2028',
        currencyCode: 'BRL',
        issuerName: 'Banco X',
        indexationType: 'CDI',
        indexPercentage: '110.0000',
        issueDate: '2024-01-01',
        maturityDate: '2028-01-01',
        couponFrequency: 'NONE',
        dayCountConvention: 'BUS252',
        faceValue: '1000.000000',
        allowsEarlyRedemption: true,
        taxRegime: 'REGRESSIVE_IR',
      });
    expect(createCdb.status).toBe(201);
    expect(createCdb.body).toMatchObject({
      instrumentType: 'FIXED_INCOME',
      issuerName: 'Banco X',
    });
    const cdbId = (createCdb.body as { id: string }).id;
    expect(typeof (createCdb.body as { ownerUserId: unknown }).ownerUserId).toBe('string');

    // -- GET /portfolios (as A) returns exactly that portfolio --
    const listAsA = await request(server)
      .get('/portfolios')
      .set('Authorization', `Bearer ${tokenA}`);
    expect(listAsA.status).toBe(200);
    expect(listAsA.body).toEqual([createPortfolio.body]);

    // -- register + login user B --
    const registerB = await register(emailB, 'Walker B');
    expect(registerB.status).toBe(201);

    const loginB = await login(emailB);
    expect(loginB.status).toBe(200);
    const tokenB = (loginB.body as AuthBody).accessToken;

    // -- GET /portfolios (as B) returns [] --
    const listAsB = await request(server)
      .get('/portfolios')
      .set('Authorization', `Bearer ${tokenB}`);
    expect(listAsB.status).toBe(200);
    expect(listAsB.body).toEqual([]);

    // -- GET /portfolios/<A's id> (as B) returns 404 --
    const getAPortfolioAsB = await request(server)
      .get(`/portfolios/${portfolioId}`)
      .set('Authorization', `Bearer ${tokenB}`);
    expect(getAPortfolioAsB.status).toBe(404);

    // -- GET /instruments (as B) does not list A's CDB --
    const listInstrumentsAsB = await request(server)
      .get('/instruments')
      .set('Authorization', `Bearer ${tokenB}`);
    expect(listInstrumentsAsB.status).toBe(200);
    expect((listInstrumentsAsB.body as { id: string }[]).map((i) => i.id)).not.toContain(
      cdbId,
    );
  });
});
