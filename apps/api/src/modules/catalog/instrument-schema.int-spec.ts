import { randomUUID } from 'node:crypto';

import { Test, type TestingModule } from '@nestjs/testing';

import { seedReferenceData } from '../../../prisma/seed';
import { checkViolation, foreignKeyViolation, uniqueViolation } from '../../../test/pg-error';
import { PrismaModule } from '../../shared/prisma/prisma.module';
import { PrismaService } from '../../shared/prisma/prisma.service';

/**
 * Structural invariants owned by the `instrument` class-table hierarchy
 * (`docs/adr/0005-instrument-inheritance.md`, Task 13), asserted at the
 * database rather than through the ORM (`SPEC.md` §Testing Strategy). Every
 * write in cases 1, 2, 3 and 5 below is raw SQL with no service or repository
 * in the path -- a passing test proves PostgreSQL itself enforces the
 * constraint, not that application code refused to attempt it.
 *
 * `SPEC-catalog.md` acceptance criteria exercised here:
 *  - a database-level constraint rejects a specialization that does not
 *    match its base row's `instrument_type` (composite FK, 23503);
 *  - exactly one specialization row is required -- neither zero nor two
 *    (deferred constraint trigger for the zero case, the same composite FK
 *    for the two-different-types case);
 *  - public natural-key uniqueness applies only to `owner_user_id IS NULL`
 *    rows (partial unique index, 23505);
 *  - `is_variable_income` is enforced, not trusted, by a CHECK constraint;
 *  - the real generated Prisma client can nested-create and `include`-read
 *    across the shared-PK 1:1 layout (the ADR's stated open risk).
 */
describe('instrument schema (integration)', () => {
  let moduleRef: TestingModule;
  let prisma: PrismaService;

  const currencyCode = 'BRL';
  const exchangeCode = 'B3';

  beforeEach(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [PrismaModule],
    }).compile();
    await moduleRef.init();
    prisma = moduleRef.get(PrismaService);

    // TRUNCATE (test/integration-setup.ts) wipes every table before each
    // test, `instrument_type` included. `seedReferenceData` is the one
    // function every future test that needs a currency/exchange/instrument
    // type already calls (`reference-data.int-spec.ts`); using it here rather
    // than a bespoke raw-SQL re-seed (fix round 1, F13.4) means Task 14/15's
    // test files inherit the same fixture setup instead of rediscovering it.
    // It seeds 'BRL' and 'B3' among others, matching `currencyCode` /
    // `exchangeCode` below.
    await seedReferenceData(prisma);
  });

  afterEach(async () => {
    await moduleRef.close();
  });

  async function createUser(email: string): Promise<{ id: string }> {
    return prisma.user.create({
      data: {
        email,
        displayName: 'Test User',
        baseCurrencyCode: currencyCode,
        timezone: 'America/Sao_Paulo',
      },
      select: { id: true },
    });
  }

  /**
   * Only the raw-SQL escape hatch is needed inside `$transaction` callbacks
   * below -- narrowing to it (rather than the full `PrismaService`) avoids a
   * cast at every call site, since the transaction client Prisma hands back
   * is a distinct type that still exposes `$executeRawUnsafe`.
   */
  type RawExecutor = Pick<PrismaService, '$executeRawUnsafe'>;

  /** Raw base-row insert -- no service layer, no Prisma model write. */
  async function insertBase(
    tx: RawExecutor,
    args: {
      id: string;
      type: string;
      ownerUserId?: string | null;
      isVariableIncome?: boolean;
      name?: string;
    },
  ): Promise<void> {
    await tx.$executeRawUnsafe(
      `INSERT INTO "instrument"
         ("id", "instrument_type", "owner_user_id", "name", "currency_code", "status", "is_variable_income", "updated_at")
       VALUES ($1, $2, $3, $4, $5, 'ACTIVE', $6, now())`,
      args.id,
      args.type,
      args.ownerUserId ?? null,
      args.name ?? `Test ${args.type} ${args.id}`,
      currencyCode,
      args.isVariableIncome ?? args.type !== 'FIXED_INCOME',
    );
  }

  async function insertEquity(
    tx: RawExecutor,
    args: {
      instrumentId: string;
      ticker: string;
      exchangeCode?: string;
      /**
       * Deliberately settable so F13.3's test can prove the sync trigger
       * CLOBBERS an explicitly supplied value rather than merely filling a
       * gap left by omitting the column.
       */
      ownerUserId?: string;
    },
  ): Promise<void> {
    await tx.$executeRawUnsafe(
      `INSERT INTO "instrument_equity" ("instrument_id", "ticker", "exchange_code", "owner_user_id")
       VALUES ($1, $2, $3, $4)`,
      args.instrumentId,
      args.ticker,
      args.exchangeCode ?? exchangeCode,
      args.ownerUserId ?? null,
    );
  }

  async function insertCrypto(
    tx: RawExecutor,
    args: { instrumentId: string; symbol: string; network?: string | null },
  ): Promise<void> {
    await tx.$executeRawUnsafe(
      `INSERT INTO "instrument_crypto" ("instrument_id", "symbol", "network", "decimals")
       VALUES ($1, $2, $3, 8)`,
      args.instrumentId,
      args.symbol,
      args.network ?? null,
    );
  }

  async function insertFixedIncome(
    tx: RawExecutor,
    args: { instrumentId: string; issuerName?: string },
  ): Promise<void> {
    await tx.$executeRawUnsafe(
      `INSERT INTO "instrument_fixed_income"
         ("instrument_id", "issuer_name", "indexation_type", "issue_date", "maturity_date",
          "coupon_frequency", "day_count_convention", "allows_early_redemption")
       VALUES ($1, $2, 'IPCA', DATE '2024-01-01', DATE '2030-01-01', 'NONE', 'BUS252', false)`,
      args.instrumentId,
      args.issuerName ?? 'Tesouro Nacional',
    );
  }

  // --- Case 1: mismatched specialization ------------------------------------

  it('rejects a specialization row that does not match the base instrument_type (composite FK, 23503)', async () => {
    const id = randomUUID();

    const attempt = prisma.$transaction(async (tx) => {
      await insertBase(tx, { id, type: 'EQUITY' });
      // EQUITY base, FIXED_INCOME specialization: the composite FK
      // (instrument_id, instrument_type) has no (id, 'FIXED_INCOME') row on
      // `instrument` to reference.
      await insertFixedIncome(tx, { instrumentId: id });
    });

    await expect(attempt).rejects.toMatchObject(foreignKeyViolation);

    const count = await prisma.instrument.count({ where: { id } });
    expect(count).toBe(0);
  });

  // --- Case 2: zero specializations ------------------------------------------

  it('rejects an instrument with zero specialization rows (deferred constraint trigger, 23514)', async () => {
    const id = randomUUID();

    const attempt = prisma.$transaction(async (tx) => {
      await insertBase(tx, { id, type: 'EQUITY' });
      // The trigger is INITIALLY DEFERRED, so a bare INSERT with no
      // specialization would otherwise pass until COMMIT. Force it here so
      // the failure surfaces as a statement error inside the transaction,
      // with the RAISE message available on the error rather than only at
      // an opaque COMMIT-time failure.
      await tx.$executeRawUnsafe(`SET CONSTRAINTS ALL IMMEDIATE`);
    });

    await expect(attempt).rejects.toMatchObject(checkViolation);
    await expect(attempt).rejects.toThrow('23514');
    await expect(attempt).rejects.toThrow('exactly one is required');

    const count = await prisma.instrument.count({ where: { id } });
    expect(count).toBe(0);
  });

  // --- Case 3: two specializations of different types -------------------------

  it('rejects a second specialization row of a different type (composite FK, 23503)', async () => {
    const id = randomUUID();

    await prisma.$transaction(async (tx) => {
      await insertBase(tx, { id, type: 'EQUITY' });
      await insertEquity(tx, { instrumentId: id, ticker: 'VALE3' });
    });

    const attempt = insertCrypto(prisma, { instrumentId: id, symbol: 'VALE', network: 'ETHEREUM' });

    await expect(attempt).rejects.toMatchObject(foreignKeyViolation);
  });

  // --- Case 4: partial unique index on the public natural key -----------------

  describe('partial unique index on the public natural key', () => {
    it('lets two different owners each hold a private equity with the same (exchange_code, ticker)', async () => {
      const userA = await createUser('a@example.com');
      const userB = await createUser('b@example.com');

      const idA = randomUUID();
      const idB = randomUUID();

      await prisma.$transaction(async (tx) => {
        await insertBase(tx, { id: idA, type: 'EQUITY', ownerUserId: userA.id });
        await insertEquity(tx, { instrumentId: idA, ticker: 'MGLU3' });
      });

      await prisma.$transaction(async (tx) => {
        await insertBase(tx, { id: idB, type: 'EQUITY', ownerUserId: userB.id });
        await insertEquity(tx, { instrumentId: idB, ticker: 'MGLU3' });
      });

      // Both rows landed, and the trigger copied owner_user_id onto the
      // specialization row rather than leaving it null.
      const rows = await prisma.instrumentEquity.findMany({
        where: { ticker: 'MGLU3' },
      });
      expect(rows).toHaveLength(2);
      expect(rows.map((r) => r.ownerUserId).sort()).toEqual([userA.id, userB.id].sort());
    });

    it('rejects a second PUBLIC equity with the same (exchange_code, ticker) (23505)', async () => {
      const idA = randomUUID();
      const idB = randomUUID();

      await prisma.$transaction(async (tx) => {
        await insertBase(tx, { id: idA, type: 'EQUITY', ownerUserId: null });
        await insertEquity(tx, { instrumentId: idA, ticker: 'ITUB4' });
      });

      const attempt = prisma.$transaction(async (tx) => {
        await insertBase(tx, { id: idB, type: 'EQUITY', ownerUserId: null });
        await insertEquity(tx, { instrumentId: idB, ticker: 'ITUB4' });
      });

      await expect(attempt).rejects.toMatchObject(uniqueViolation);
    });

    it('applies the same rule to crypto (symbol, network)', async () => {
      const userA = await createUser('crypto-a@example.com');
      const userB = await createUser('crypto-b@example.com');

      const idPrivateA = randomUUID();
      const idPrivateB = randomUUID();
      const idPublic1 = randomUUID();
      const idPublic2 = randomUUID();

      await prisma.$transaction(async (tx) => {
        await insertBase(tx, { id: idPrivateA, type: 'CRYPTO', ownerUserId: userA.id });
        await insertCrypto(tx, {
          instrumentId: idPrivateA,
          symbol: 'USDC',
          network: 'ETHEREUM',
        });
      });
      await prisma.$transaction(async (tx) => {
        await insertBase(tx, { id: idPrivateB, type: 'CRYPTO', ownerUserId: userB.id });
        await insertCrypto(tx, {
          instrumentId: idPrivateB,
          symbol: 'USDC',
          network: 'ETHEREUM',
        });
      });
      await prisma.$transaction(async (tx) => {
        await insertBase(tx, { id: idPublic1, type: 'CRYPTO', ownerUserId: null });
        await insertCrypto(tx, {
          instrumentId: idPublic1,
          symbol: 'USDC',
          network: 'ETHEREUM',
        });
      });

      const attempt = prisma.$transaction(async (tx) => {
        await insertBase(tx, { id: idPublic2, type: 'CRYPTO', ownerUserId: null });
        await insertCrypto(tx, {
          instrumentId: idPublic2,
          symbol: 'USDC',
          network: 'ETHEREUM',
        });
      });

      await expect(attempt).rejects.toMatchObject(uniqueViolation);
    });

    // F13.3: the sync trigger's `SELECT ... INTO NEW.owner_user_id` is
    // unconditional -- it must CLOBBER a value the client explicitly
    // supplied, not just fill a gap left by omitting the column. If it only
    // filled gaps, a caller could smuggle an arbitrary owner_user_id straight
    // onto the specialization row and evade the partial index's
    // `WHERE owner_user_id IS NULL` predicate, defeating public-uniqueness
    // entirely.
    it('the owner_user_id sync trigger clobbers an explicitly supplied value, not just a gap', async () => {
      const idPublic = randomUUID();
      const smuggledOwnerId = randomUUID();

      await prisma.$transaction(async (tx) => {
        // Public base row (owner_user_id IS NULL) ...
        await insertBase(tx, { id: idPublic, type: 'EQUITY', ownerUserId: null });
        // ... but the specialization INSERT explicitly supplies a non-null
        // owner_user_id, as if trying to evade the partial index.
        await insertEquity(tx, {
          instrumentId: idPublic,
          ticker: 'CLOBBER4',
          ownerUserId: smuggledOwnerId,
        });
      });

      const stored = await prisma.instrumentEquity.findUniqueOrThrow({
        where: { instrumentId: idPublic },
      });
      // (a) the trigger overwrote the supplied value with the base row's
      // real (null) owner_user_id.
      expect(stored.ownerUserId).toBeNull();

      // (b) so the row is genuinely public, and a second public row with the
      // same natural key is still rejected -- the partial index was never
      // bypassed.
      const idSecondPublic = randomUUID();
      const attempt = prisma.$transaction(async (tx) => {
        await insertBase(tx, { id: idSecondPublic, type: 'EQUITY', ownerUserId: null });
        await insertEquity(tx, { instrumentId: idSecondPublic, ticker: 'CLOBBER4' });
      });

      await expect(attempt).rejects.toMatchObject(uniqueViolation);
    });
  });

  // --- Case 5: is_variable_income CHECK ---------------------------------------

  it('rejects is_variable_income=true on a FIXED_INCOME base row (CHECK constraint, 23514)', async () => {
    const id = randomUUID();

    const attempt = insertBase(prisma, { id, type: 'FIXED_INCOME', isVariableIncome: true });

    await expect(attempt).rejects.toMatchObject(checkViolation);
    await expect(attempt).rejects.toThrow('23514');
    await expect(attempt).rejects.toThrow('instrument_is_variable_income_chk');
    const count = await prisma.instrument.count({ where: { id } });
    expect(count).toBe(0);
  });

  it('rejects is_variable_income=false on an EQUITY base row (CHECK constraint, 23514)', async () => {
    const id = randomUUID();

    const attempt = insertBase(prisma, { id, type: 'EQUITY', isVariableIncome: false });

    await expect(attempt).rejects.toMatchObject(checkViolation);
    await expect(attempt).rejects.toThrow('23514');
    await expect(attempt).rejects.toThrow('instrument_is_variable_income_chk');
    const count = await prisma.instrument.count({ where: { id } });
    expect(count).toBe(0);
  });

  // --- Case 6: real Prisma client nested create + include (closes the ADR's open risk) ---

  it('creates base + equity specialization via a real Prisma nested create, and reads them back via include', async () => {
    const created = await prisma.instrument.create({
      data: {
        instrumentType: 'EQUITY',
        name: 'Petrobras PN',
        currencyCode,
        status: 'ACTIVE',
        isVariableIncome: true,
        equity: {
          create: {
            ticker: 'PETR4',
            exchangeCode,
            isin: 'BRPETRACNPR6',
            sector: 'Energy',
          },
        },
      },
      include: { equity: true },
    });

    expect(created.equity).toMatchObject({
      instrumentId: created.id,
      ticker: 'PETR4',
      exchangeCode,
      isin: 'BRPETRACNPR6',
    });

    const read = await prisma.instrument.findUniqueOrThrow({
      where: { id: created.id },
      include: { equity: true },
    });

    expect(read.instrumentType).toBe('EQUITY');
    expect(read.equity).not.toBeNull();
    expect(read.equity?.ticker).toBe('PETR4');
    // owner_user_id was never supplied; the sync trigger still ran and left
    // the specialization's copy consistent with the (null) base value.
    expect(read.equity?.ownerUserId).toBeNull();
  });

  it('creates base + fixed-income specialization via a real Prisma nested create', async () => {
    const created = await prisma.instrument.create({
      data: {
        instrumentType: 'FIXED_INCOME',
        name: 'Tesouro IPCA+ 2030',
        currencyCode,
        status: 'ACTIVE',
        isVariableIncome: false,
        fixedIncome: {
          create: {
            issuerName: 'Tesouro Nacional',
            indexationType: 'IPCA',
            issueDate: new Date('2024-01-01'),
            maturityDate: new Date('2030-01-01'),
            couponFrequency: 'SEMIANNUAL',
            dayCountConvention: 'BUS252',
            allowsEarlyRedemption: false,
          },
        },
      },
      include: { fixedIncome: true },
    });

    expect(created.fixedIncome).toMatchObject({
      instrumentId: created.id,
      issuerName: 'Tesouro Nacional',
      indexationType: 'IPCA',
    });
  });

  // --- F13.1 (fix round 1): owner deletion must not silently publicize a private instrument ---

  it('rejects deleting a user who owns a private instrument (owner_user_id FK, ON DELETE RESTRICT, 23503)', async () => {
    const owner = await createUser('owner@example.com');

    const instrument = await prisma.instrument.create({
      data: {
        instrumentType: 'FIXED_INCOME',
        name: 'Private CDB',
        currencyCode,
        status: 'ACTIVE',
        isVariableIncome: false,
        ownerUserId: owner.id,
        fixedIncome: {
          create: {
            issuerName: 'Banco X',
            indexationType: 'CDI',
            issueDate: new Date('2024-01-01'),
            maturityDate: new Date('2026-01-01'),
            couponFrequency: 'NONE',
            dayCountConvention: 'BUS252',
            allowsEarlyRedemption: true,
          },
        },
      },
    });

    // Prisma's default for an optional relation is ON DELETE SET NULL, which
    // here would silently convert this PRIVATE instrument into a PUBLIC one
    // (owner_user_id IS NULL means public -- SPEC-catalog.md). The schema
    // overrides that default to Restrict (F13.1); this proves the override
    // actually reached the database, not just schema.prisma.
    //
    // This goes through the typed `prisma.user.delete()` call, not raw SQL,
    // so the error is Prisma's own P2003 classification (`code`/`meta` on
    // the error directly) rather than the `driverAdapterError` shape
    // `foreignKeyViolation` matches for raw `$executeRawUnsafe` failures.
    const attempt = prisma.user.delete({ where: { id: owner.id } });

    await expect(attempt).rejects.toMatchObject({ code: 'P2003' });
    await expect(attempt).rejects.toThrow('instrument_owner_user_id_fkey');

    const stillPrivate = await prisma.instrument.findUniqueOrThrow({
      where: { id: instrument.id },
    });
    expect(stillPrivate.ownerUserId).toBe(owner.id);
  });
});
