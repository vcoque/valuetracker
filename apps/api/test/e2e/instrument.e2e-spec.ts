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
 * `SPEC-catalog.md` §Verification (Task 14 slice): `GET /instruments`
 * returns public instruments union the caller's own private ones; `GET
 * /instruments/:id` on a private instrument belonging to someone else is
 * 404, never 403 -- ids must not be enumerable, same rule
 * `portfolio.e2e-spec.ts` exercises for portfolios.
 *
 * `POST /instruments` does not exist yet (Task 15), so every fixture here is
 * written directly through `PrismaService`'s real nested `create`
 * (Task 13's proven pattern, `instrument-schema.int-spec.ts` Case 6) rather
 * than through the HTTP API.
 */
describe('instrument endpoints (e2e)', () => {
  let app: NestFastifyApplication;

  const register = async (
    email: string,
  ): Promise<{ token: string; userId: string }> => {
    const response = await request(app.getHttpServer())
      .post('/auth/register')
      .send({
        email,
        password: 'a-sufficiently-long-password',
        displayName: 'Instrument Reader',
        clientType: 'ANDROID',
      });
    const token = (response.body as { accessToken: string }).accessToken;
    const payloadSegment = token.split('.')[1];
    const payload = JSON.parse(
      Buffer.from(payloadSegment, 'base64url').toString('utf8'),
    ) as { sub: string };
    return { token, userId: payload.sub };
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

  function prisma(): PrismaService {
    return app.get(PrismaService);
  }

  async function createEquity(args: {
    ownerUserId?: string | null;
    ticker: string;
    name?: string;
  }): Promise<string> {
    const instrument = await prisma().instrument.create({
      data: {
        instrumentType: 'EQUITY',
        ownerUserId: args.ownerUserId ?? null,
        name: args.name ?? `${args.ticker} co.`,
        currencyCode: 'BRL',
        status: 'ACTIVE',
        isVariableIncome: true,
        equity: {
          create: { ticker: args.ticker, exchangeCode: 'B3', sector: 'Energy' },
        },
      },
    });
    return instrument.id;
  }

  async function createEtf(args: {
    ownerUserId?: string | null;
    ticker: string;
  }): Promise<string> {
    const instrument = await prisma().instrument.create({
      data: {
        instrumentType: 'ETF',
        ownerUserId: args.ownerUserId ?? null,
        name: `${args.ticker} ETF`,
        currencyCode: 'BRL',
        status: 'ACTIVE',
        isVariableIncome: true,
        etf: {
          create: {
            ticker: args.ticker,
            exchangeCode: 'B3',
            benchmarkIndex: 'IBOVESPA',
            expenseRatio: '0.0500',
            replicationMethod: 'PHYSICAL',
          },
        },
      },
    });
    return instrument.id;
  }

  async function createFixedIncome(args: {
    ownerUserId?: string | null;
    issuerName?: string;
  }): Promise<string> {
    const instrument = await prisma().instrument.create({
      data: {
        instrumentType: 'FIXED_INCOME',
        ownerUserId: args.ownerUserId ?? null,
        name: 'Tesouro IPCA+ 2030',
        currencyCode: 'BRL',
        status: 'ACTIVE',
        isVariableIncome: false,
        fixedIncome: {
          create: {
            issuerName: args.issuerName ?? 'Tesouro Nacional',
            indexationType: 'IPCA',
            contractedRate: '5.500000',
            issueDate: new Date('2024-01-01'),
            maturityDate: new Date('2030-01-01'),
            couponFrequency: 'SEMIANNUAL',
            dayCountConvention: 'BUS252',
            faceValue: '1000.000000',
            allowsEarlyRedemption: false,
            taxRegime: 'EXEMPT',
          },
        },
      },
    });
    return instrument.id;
  }

  async function createCrypto(args: {
    ownerUserId?: string | null;
    symbol: string;
  }): Promise<string> {
    const instrument = await prisma().instrument.create({
      data: {
        instrumentType: 'CRYPTO',
        ownerUserId: args.ownerUserId ?? null,
        name: `${args.symbol} coin`,
        currencyCode: 'USD',
        status: 'ACTIVE',
        isVariableIncome: true,
        crypto: {
          create: { symbol: args.symbol, network: 'BITCOIN', decimals: 8 },
        },
      },
    });
    return instrument.id;
  }

  it('rejects GET /instruments and GET /instruments/:id with no access token (401)', async () => {
    const server = app.getHttpServer();
    expect((await request(server).get('/instruments')).status).toBe(401);
    expect(
      (await request(server).get(`/instruments/${'0'.repeat(8)}-0000-0000-0000-000000000000`))
        .status,
    ).toBe(401);
  });

  it('isolates a private instrument to its owner: absent from another user\'s list, 404 on direct get', async () => {
    const server = app.getHttpServer();
    const a = await register(`inst-a-${Date.now()}@example.com`);
    const b = await register(`inst-b-${Date.now()}@example.com`);

    const privateId = await createEquity({ ownerUserId: a.userId, ticker: 'PRIV4' });

    const listAsA = await request(server)
      .get('/instruments')
      .set('Authorization', `Bearer ${a.token}`);
    expect(listAsA.status).toBe(200);
    expect((listAsA.body as { id: string }[]).map((i) => i.id)).toContain(privateId);

    const listAsB = await request(server)
      .get('/instruments')
      .set('Authorization', `Bearer ${b.token}`);
    expect(listAsB.status).toBe(200);
    expect((listAsB.body as { id: string }[]).map((i) => i.id)).not.toContain(privateId);

    const getAsB = await request(server)
      .get(`/instruments/${privateId}`)
      .set('Authorization', `Bearer ${b.token}`);
    expect(getAsB.status).toBe(404);

    const getAsA = await request(server)
      .get(`/instruments/${privateId}`)
      .set('Authorization', `Bearer ${a.token}`);
    expect(getAsA.status).toBe(200);
    expect(getAsA.body).toMatchObject({
      id: privateId,
      instrumentType: 'EQUITY',
      ownerUserId: a.userId,
      ticker: 'PRIV4',
      exchangeCode: 'B3',
    });
    // ownerUserId, when present, is always the CALLER's own id -- never
    // another user's. It is structurally impossible for it to equal b.userId
    // here since B's request 404'd, but assert it explicitly too.
    expect((getAsA.body as { ownerUserId: string }).ownerUserId).not.toBe(b.userId);
  });

  it('a PUBLIC instrument is visible to any authenticated caller, with a null ownerUserId', async () => {
    const server = app.getHttpServer();
    const a = await register(`inst-pub-a-${Date.now()}@example.com`);
    const b = await register(`inst-pub-b-${Date.now()}@example.com`);

    const publicId = await createEquity({ ownerUserId: null, ticker: 'PUBL4' });

    for (const caller of [a, b]) {
      const getResponse = await request(server)
        .get(`/instruments/${publicId}`)
        .set('Authorization', `Bearer ${caller.token}`);
      expect(getResponse.status).toBe(200);
      expect(getResponse.body).toMatchObject({ id: publicId, ownerUserId: null });

      const listResponse = await request(server)
        .get('/instruments')
        .set('Authorization', `Bearer ${caller.token}`);
      expect((listResponse.body as { id: string }[]).map((i) => i.id)).toContain(publicId);
    }
  });

  it('returns 404, not the real instrument, for a non-existent id', async () => {
    const a = await register(`inst-missing-${Date.now()}@example.com`);
    const response = await request(app.getHttpServer())
      .get(`/instruments/${'1'.repeat(8)}-1111-1111-1111-111111111111`)
      .set('Authorization', `Bearer ${a.token}`);
    expect(response.status).toBe(404);
  });

  it('returns each of the four asset classes as the correct discriminated-union shape', async () => {
    const server = app.getHttpServer();
    const a = await register(`inst-shapes-${Date.now()}@example.com`);
    const auth = { Authorization: `Bearer ${a.token}` };

    const etfId = await createEtf({ ownerUserId: null, ticker: 'BOVA11' });
    const fixedIncomeId = await createFixedIncome({ ownerUserId: null });
    const cryptoId = await createCrypto({ ownerUserId: null, symbol: 'BTC' });

    const etfResponse = await request(server).get(`/instruments/${etfId}`).set(auth);
    expect(etfResponse.status).toBe(200);
    expect(etfResponse.body).toMatchObject({
      instrumentType: 'ETF',
      ticker: 'BOVA11',
      benchmarkIndex: 'IBOVESPA',
      replicationMethod: 'PHYSICAL',
    });
    // Money on the wire is a decimal STRING, never a JSON number (SPEC.md
    // §Boundaries).
    expect(typeof (etfResponse.body as { expenseRatio: unknown }).expenseRatio).toBe('string');
    expect((etfResponse.body as { expenseRatio: string }).expenseRatio).toBe('0.0500');

    const fixedIncomeResponse = await request(server)
      .get(`/instruments/${fixedIncomeId}`)
      .set(auth);
    expect(fixedIncomeResponse.status).toBe(200);
    expect(fixedIncomeResponse.body).toMatchObject({
      instrumentType: 'FIXED_INCOME',
      issuerName: 'Tesouro Nacional',
      indexationType: 'IPCA',
      contractedRate: '5.500000',
      faceValue: '1000.000000',
      issueDate: '2024-01-01',
      maturityDate: '2030-01-01',
    });

    const cryptoResponse = await request(server).get(`/instruments/${cryptoId}`).set(auth);
    expect(cryptoResponse.status).toBe(200);
    expect(cryptoResponse.body).toMatchObject({
      instrumentType: 'CRYPTO',
      symbol: 'BTC',
      network: 'BITCOIN',
      decimals: 8,
    });
  });

  describe('search filters', () => {
    it('filters by type', async () => {
      const a = await register(`inst-search-type-${Date.now()}@example.com`);
      await createEquity({ ownerUserId: null, ticker: 'TYPA4' });
      await createCrypto({ ownerUserId: null, symbol: 'TYPB' });

      const response = await request(app.getHttpServer())
        .get('/instruments?type=CRYPTO')
        .set('Authorization', `Bearer ${a.token}`);
      expect(response.status).toBe(200);
      const types = new Set((response.body as { instrumentType: string }[]).map((i) => i.instrumentType));
      expect(types.has('CRYPTO')).toBe(true);
      expect(types.has('EQUITY')).toBe(false);
    });

    it('filters by ticker, case-insensitively, across equity and etf', async () => {
      const a = await register(`inst-search-ticker-${Date.now()}@example.com`);
      const equityId = await createEquity({ ownerUserId: null, ticker: 'SRCH4' });
      const etfId = await createEtf({ ownerUserId: null, ticker: 'SRCHB11' });
      await createEquity({ ownerUserId: null, ticker: 'OTHR3' });

      const response = await request(app.getHttpServer())
        .get('/instruments?ticker=srch')
        .set('Authorization', `Bearer ${a.token}`);
      expect(response.status).toBe(200);
      const ids = (response.body as { id: string }[]).map((i) => i.id);
      expect(ids.sort()).toEqual([equityId, etfId].sort());
    });

    it('filters by name, case-insensitively', async () => {
      const a = await register(`inst-search-name-${Date.now()}@example.com`);
      const id = await createEquity({
        ownerUserId: null,
        ticker: 'NAME4',
        name: 'Very Unique Company Name',
      });
      await createEquity({ ownerUserId: null, ticker: 'DIFF3', name: 'Something Else' });

      const response = await request(app.getHttpServer())
        .get('/instruments?name=unique company')
        .set('Authorization', `Bearer ${a.token}`);
      expect(response.status).toBe(200);
      expect((response.body as { id: string }[]).map((i) => i.id)).toEqual([id]);
    });

    it('rejects an unrecognized query param with a 400', async () => {
      const a = await register(`inst-search-bad-${Date.now()}@example.com`);
      const response = await request(app.getHttpServer())
        .get('/instruments?bogus=1')
        .set('Authorization', `Bearer ${a.token}`);
      expect(response.status).toBe(400);
    });
  });
});
