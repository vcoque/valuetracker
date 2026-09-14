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
 * `SPEC-catalog.md` §Verification: Task 14's read slice -- `GET
 * /instruments` returns public instruments union the caller's own private
 * ones; `GET /instruments/:id` on a private instrument belonging to someone
 * else is 404, never 403 -- ids must not be enumerable, same rule
 * `portfolio.e2e-spec.ts` exercises for portfolios -- plus Task 15's write
 * slice, at the bottom of this file: `POST /instruments` /
 * `PATCH /instruments/:id`, FIXED_INCOME only.
 *
 * Every fixture above the `POST`/`PATCH` describe block is written directly
 * through `PrismaService`'s real nested `create` (Task 13's proven pattern,
 * `instrument-schema.int-spec.ts` Case 6) rather than through the HTTP API --
 * that part of the file predates Task 15 and still needs equity/ETF/crypto
 * fixtures the write API deliberately does not create.
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

  /**
   * Task 15: `POST /instruments` / `PATCH /instruments/:id` -- FIXED_INCOME
   * only (`SPEC-catalog.md` §API Surface: "Create a **private** instrument
   * (fixed income)"). Unlike every fixture above, these go through the real
   * HTTP API, not `PrismaService` directly.
   */
  describe('POST /instruments and PATCH /instruments/:id (fixed income)', () => {
    function validCdb(overrides: Record<string, unknown> = {}): Record<string, unknown> {
      return {
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
        ...overrides,
      };
    }

    it('rejects POST/PATCH with no access token (401)', async () => {
      const server = app.getHttpServer();
      expect((await request(server).post('/instruments').send(validCdb())).status).toBe(401);
      expect(
        (
          await request(server)
            .patch(`/instruments/${'0'.repeat(8)}-0000-0000-0000-000000000000`)
            .send({ issuerName: 'X' })
        ).status,
      ).toBe(401);
    });

    it(
      'creates a private CDB as user A, reads it back via GET /instruments/:id; ' +
        "user B gets 404 on it and it's absent from B's GET /instruments",
      async () => {
        const server = app.getHttpServer();
        const a = await register(`inst-post-a-${Date.now()}@example.com`);
        const b = await register(`inst-post-b-${Date.now()}@example.com`);

        const createResponse = await request(server)
          .post('/instruments')
          .set('Authorization', `Bearer ${a.token}`)
          .send(validCdb());
        expect(createResponse.status).toBe(201);
        expect(createResponse.body).toMatchObject({
          instrumentType: 'FIXED_INCOME',
          ownerUserId: a.userId,
          status: 'ACTIVE',
          isVariableIncome: false,
          issuerName: 'Banco X',
          indexationType: 'CDI',
          indexPercentage: '110.0000',
          issueDate: '2024-01-01',
          maturityDate: '2028-01-01',
        });
        // Money on the wire is a decimal STRING, never a JSON number.
        expect(typeof (createResponse.body as { faceValue: unknown }).faceValue).toBe('string');
        const id = (createResponse.body as { id: string }).id;

        const getAsA = await request(server)
          .get(`/instruments/${id}`)
          .set('Authorization', `Bearer ${a.token}`);
        expect(getAsA.status).toBe(200);
        expect(getAsA.body).toMatchObject({ id, ownerUserId: a.userId, issuerName: 'Banco X' });

        const getAsB = await request(server)
          .get(`/instruments/${id}`)
          .set('Authorization', `Bearer ${b.token}`);
        expect(getAsB.status).toBe(404);

        const listAsB = await request(server)
          .get('/instruments')
          .set('Authorization', `Bearer ${b.token}`);
        expect(listAsB.status).toBe(200);
        expect((listAsB.body as { id: string }[]).map((i) => i.id)).not.toContain(id);
      },
    );

    it.each(['ownerUserId', 'instrumentType', 'isVariableIncome', 'status', 'dataSourceId'])(
      'rejects an attempt to set %s in the POST body with a 400 (.strict(), not silently ignored)',
      async (forbiddenField) => {
        const a = await register(`inst-post-forbidden-${forbiddenField}-${Date.now()}@example.com`);
        const response = await request(app.getHttpServer())
          .post('/instruments')
          .set('Authorization', `Bearer ${a.token}`)
          .send(validCdb({ [forbiddenField]: 'anything' }));
        expect(response.status).toBe(400);
      },
    );

    it('rejects maturityDate before issueDate with a 400', async () => {
      const a = await register(`inst-post-baddates-${Date.now()}@example.com`);
      const response = await request(app.getHttpServer())
        .post('/instruments')
        .set('Authorization', `Bearer ${a.token}`)
        .send(validCdb({ issueDate: '2028-01-01', maturityDate: '2024-01-01' }));
      expect(response.status).toBe(400);
    });

    it('rejects an unrecognized indexationType with a 400', async () => {
      const a = await register(`inst-post-badindex-${Date.now()}@example.com`);
      const response = await request(app.getHttpServer())
        .post('/instruments')
        .set('Authorization', `Bearer ${a.token}`)
        .send(validCdb({ indexationType: 'LIBOR' }));
      expect(response.status).toBe(400);
    });

    // F15.2 (fix round 1): "2024-02-30" matches dateOnlySchema's YYYY-MM-DD
    // shape but names no real calendar day -- JS's `Date` constructor would
    // silently roll it over to 2024-03-01 rather than reject it, so this
    // pins that `dateOnlySchema` itself refuses the value before it ever
    // reaches a `new Date(...)` call.
    it('rejects a malformed calendar date ("2024-02-30") in issueDate with a 400', async () => {
      const a = await register(`inst-post-badissuedate-${Date.now()}@example.com`);
      const response = await request(app.getHttpServer())
        .post('/instruments')
        .set('Authorization', `Bearer ${a.token}`)
        .send(validCdb({ issueDate: '2024-02-30' }));
      expect(response.status).toBe(400);
    });

    it('rejects a malformed calendar date ("2024-02-30") in maturityDate with a 400', async () => {
      const a = await register(`inst-post-badmaturitydate-${Date.now()}@example.com`);
      const response = await request(app.getHttpServer())
        .post('/instruments')
        .set('Authorization', `Bearer ${a.token}`)
        .send(validCdb({ maturityDate: '2024-02-30' }));
      expect(response.status).toBe(400);
    });

    it('PATCH on another user\'s instrument returns 404, and leaves it unchanged', async () => {
      const server = app.getHttpServer();
      const a = await register(`inst-patch-owner-${Date.now()}@example.com`);
      const b = await register(`inst-patch-stranger-${Date.now()}@example.com`);

      const createResponse = await request(server)
        .post('/instruments')
        .set('Authorization', `Bearer ${a.token}`)
        .send(validCdb());
      const id = (createResponse.body as { id: string }).id;

      const patchAsB = await request(server)
        .patch(`/instruments/${id}`)
        .set('Authorization', `Bearer ${b.token}`)
        .send({ issuerName: 'Hijacked Bank' });
      expect(patchAsB.status).toBe(404);

      const getAsA = await request(server)
        .get(`/instruments/${id}`)
        .set('Authorization', `Bearer ${a.token}`);
      expect(getAsA.body).toMatchObject({ issuerName: 'Banco X' });
    });

    it('PATCH updates the fields sent and leaves the rest (and ownership) unchanged', async () => {
      const server = app.getHttpServer();
      const a = await register(`inst-patch-happy-${Date.now()}@example.com`);

      const createResponse = await request(server)
        .post('/instruments')
        .set('Authorization', `Bearer ${a.token}`)
        .send(validCdb());
      const id = (createResponse.body as { id: string }).id;

      const patchResponse = await request(server)
        .patch(`/instruments/${id}`)
        .set('Authorization', `Bearer ${a.token}`)
        .send({ issuerName: 'Banco X Renamed', status: 'MATURED' });
      expect(patchResponse.status).toBe(200);
      expect(patchResponse.body).toMatchObject({
        id,
        ownerUserId: a.userId,
        issuerName: 'Banco X Renamed',
        status: 'MATURED',
        // Untouched.
        indexationType: 'CDI',
        maturityDate: '2028-01-01',
      });
    });

    it('rejects a PATCH attempt to change instrumentType/ownerUserId/isVariableIncome with a 400', async () => {
      const server = app.getHttpServer();
      const a = await register(`inst-patch-forbidden-${Date.now()}@example.com`);
      const createResponse = await request(server)
        .post('/instruments')
        .set('Authorization', `Bearer ${a.token}`)
        .send(validCdb());
      const id = (createResponse.body as { id: string }).id;

      const response = await request(server)
        .patch(`/instruments/${id}`)
        .set('Authorization', `Bearer ${a.token}`)
        .send({ instrumentType: 'EQUITY' });
      expect(response.status).toBe(400);
    });

    // F15.2: the same malformed-calendar-date rejection applies on PATCH --
    // both request schemas share `dateOnlySchema`.
    it('rejects a PATCH with a malformed calendar date ("2024-02-30") in maturityDate with a 400', async () => {
      const server = app.getHttpServer();
      const a = await register(`inst-patch-badmaturitydate-${Date.now()}@example.com`);
      const createResponse = await request(server)
        .post('/instruments')
        .set('Authorization', `Bearer ${a.token}`)
        .send(validCdb());
      const id = (createResponse.body as { id: string }).id;

      const response = await request(server)
        .patch(`/instruments/${id}`)
        .set('Authorization', `Bearer ${a.token}`)
        .send({ maturityDate: '2024-02-30' });
      expect(response.status).toBe(400);
    });
  });
});
