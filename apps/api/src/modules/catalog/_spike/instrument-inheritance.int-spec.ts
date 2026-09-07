/**
 * ============================================================================
 * THROWAWAY SPIKE -- Task 5. NOT production code. Delete this whole `_spike/`
 * directory once Task 13 lands the real `catalog` module.
 * ============================================================================
 *
 * This is the GATE test for the single highest-risk decision in the project
 * (`tasks/plan.md` §Risks): can Prisma 7 + hand-authored SQL express the
 * `catalog` class-table inheritance (`SPEC-catalog.md` §"The inheritance mapping
 * is the hard part") well enough for Task 13 to build on?
 *
 * It proves four behaviours against a REAL Postgres (the Testcontainers harness
 * in `apps/api/test/`). It issues all DDL by hand via `$executeRawUnsafe` in
 * `beforeAll` -- it does NOT add models to `apps/api/prisma/schema.prisma` and
 * does NOT commit a migration. `spike.prisma` beside this file is validated (not
 * migrated) to show Prisma's schema language expresses the 1:1 relation shape.
 *
 *   1. Base `instrument` + specialization as a 1:1 relation on shared PK
 *      `instrument_id`; created and read back.
 *   2. The DB itself rejects a specialization that does not match the
 *      `instrument_type` discriminator, and rejects zero / two specialization
 *      rows -- proven with raw SQL that bypasses any ORM/service layer.
 *   3. A partial unique index on the public natural key that applies only to
 *      rows with `owner_user_id IS NULL`: two users may each hold a private
 *      instrument with the same key; a second public row with that key is
 *      rejected.
 *   4. (in `instrument-union.spec.ts`) a TypeScript discriminated union with an
 *      exhaustive switch + `assertNever`, such that a fifth `instrument_type` is
 *      a compile error until handled.
 *
 * Ruling S7: hand-authoring the CHECK / partial-index SQL *before first apply*
 * is a sanctioned deviation from `SPEC.md`'s "migrations ... never hand-edited"
 * phrasing (which forbids editing a migration *after it has been applied
 * anywhere*). Task 13 may rely on it.
 */

import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';

import { Test, type TestingModule } from '@nestjs/testing';

import { PrismaModule } from '../../../shared/prisma/prisma.module';
import { PrismaService } from '../../../shared/prisma/prisma.service';

const API_ROOT = resolve(__dirname, '../../../../');
const SPIKE_SCHEMA = resolve(__dirname, 'spike.prisma');

/**
 * The hand-authored DDL. This is exactly the SQL a Task 13 migration would
 * carry -- a joined-table hierarchy plus the three invariants Prisma cannot
 * express (`SPEC-catalog.md` §"Structural invariants owned here").
 */
const DDL: readonly string[] = [
  // `instrument_type` is a lookup table, not a CHECK-IN list: adding an asset
  // class is then an INSERT here, touching no existing table (SPEC-catalog.md:
  // "Adding a new asset class ... No existing table changes").
  `CREATE TABLE instrument_type (code text PRIMARY KEY)`,

  // Minimal `exchange` -- the real one has more columns; the FK target is all
  // this spike needs.
  `CREATE TABLE exchange (
     code varchar(16) PRIMARY KEY,
     name varchar(128) NOT NULL
   )`,

  `CREATE TABLE instrument (
     id                 uuid PRIMARY KEY,
     instrument_type    text NOT NULL REFERENCES instrument_type(code),
     owner_user_id      uuid,
     name               varchar(255) NOT NULL,
     currency_code      char(3) NOT NULL REFERENCES currency(code),
     status             varchar(16) NOT NULL,
     is_variable_income boolean NOT NULL,
     created_at         timestamptz NOT NULL DEFAULT now(),
     updated_at         timestamptz NOT NULL DEFAULT now(),
     -- the target the specialization tables' composite FK points at, so a
     -- specialization row cannot claim a discriminator its base row does not
     -- have.
     CONSTRAINT instrument_id_type_uk UNIQUE (id, instrument_type)
   )`,

  `CREATE TABLE instrument_equity (
     instrument_id  uuid PRIMARY KEY REFERENCES instrument(id) ON DELETE CASCADE,
     instrument_type text NOT NULL DEFAULT 'EQUITY',
     owner_user_id  uuid,                       -- denormalised, trigger-maintained
     ticker         varchar(16) NOT NULL,
     exchange_code  varchar(16) NOT NULL REFERENCES exchange(code),
     isin           char(12),
     sector         varchar(64),
     country_code   char(2),
     CONSTRAINT instrument_equity_type_chk CHECK (instrument_type = 'EQUITY'),
     CONSTRAINT instrument_equity_matches_base
       FOREIGN KEY (instrument_id, instrument_type)
       REFERENCES instrument (id, instrument_type)
   )`,

  `CREATE TABLE instrument_fixed_income (
     instrument_id   uuid PRIMARY KEY REFERENCES instrument(id) ON DELETE CASCADE,
     instrument_type text NOT NULL DEFAULT 'FIXED_INCOME',
     owner_user_id   uuid,
     issuer_name     varchar(255) NOT NULL,
     indexation_type varchar(16) NOT NULL,
     maturity_date   date NOT NULL,
     face_value      numeric(20,6),
     CONSTRAINT instrument_fixed_income_type_chk CHECK (instrument_type = 'FIXED_INCOME'),
     CONSTRAINT instrument_fixed_income_matches_base
       FOREIGN KEY (instrument_id, instrument_type)
       REFERENCES instrument (id, instrument_type)
   )`,

  `CREATE TABLE instrument_crypto (
     instrument_id    uuid PRIMARY KEY REFERENCES instrument(id) ON DELETE CASCADE,
     instrument_type  text NOT NULL DEFAULT 'CRYPTO',
     owner_user_id    uuid,
     symbol           varchar(16) NOT NULL,
     network          varchar(32),
     contract_address varchar(128),
     decimals         int NOT NULL,
     CONSTRAINT instrument_crypto_type_chk CHECK (instrument_type = 'CRYPTO'),
     CONSTRAINT instrument_crypto_matches_base
       FOREIGN KEY (instrument_id, instrument_type)
       REFERENCES instrument (id, instrument_type)
   )`,

  // BEHAVIOUR 3 support. The partial index predicate is `owner_user_id IS NULL`,
  // but that column lives on `instrument` while the natural-key columns live on
  // the specialization. Denormalise `owner_user_id` onto the specialization and
  // keep it honest with a BEFORE trigger, so the partial unique index can sit
  // on the specialization table where the key columns are.
  `CREATE FUNCTION spike_sync_owner_user_id() RETURNS trigger AS $fn$
     BEGIN
       SELECT i.owner_user_id INTO NEW.owner_user_id
       FROM instrument i WHERE i.id = NEW.instrument_id;
       RETURN NEW;
     END;
   $fn$ LANGUAGE plpgsql`,

  `CREATE TRIGGER instrument_equity_sync_owner
     BEFORE INSERT OR UPDATE OF instrument_id, owner_user_id ON instrument_equity
     FOR EACH ROW EXECUTE FUNCTION spike_sync_owner_user_id()`,

  `CREATE TRIGGER instrument_crypto_sync_owner
     BEFORE INSERT OR UPDATE OF instrument_id, owner_user_id ON instrument_crypto
     FOR EACH ROW EXECUTE FUNCTION spike_sync_owner_user_id()`,

  // BEHAVIOUR 3: the partial unique indexes -- public rows only.
  `CREATE UNIQUE INDEX instrument_equity_public_natural_key
     ON instrument_equity (exchange_code, ticker) WHERE owner_user_id IS NULL`,

  `CREATE UNIQUE INDEX instrument_crypto_public_natural_key
     ON instrument_crypto (symbol, network) WHERE owner_user_id IS NULL`,

  // BEHAVIOUR 2: "exactly one specialization row, matching the discriminator."
  // The composite FK on each specialization table already rejects a MISMATCHED
  // row and a SECOND row of a different type. This deferred constraint trigger
  // adds the "exactly one" half: it rejects ZERO rows (and any count != 1) at
  // COMMIT time. DEFERRED so the mid-transaction state (base inserted,
  // specialization not yet) is legal.
  `CREATE FUNCTION spike_require_one_specialization() RETURNS trigger AS $fn$
     DECLARE n int;
     BEGIN
       SELECT
           (SELECT count(*) FROM instrument_equity       WHERE instrument_id = NEW.id)
         + (SELECT count(*) FROM instrument_fixed_income WHERE instrument_id = NEW.id)
         + (SELECT count(*) FROM instrument_crypto       WHERE instrument_id = NEW.id)
         INTO n;
       IF n <> 1 THEN
         RAISE EXCEPTION
           'instrument % has % specialization rows; exactly one is required', NEW.id, n
           USING ERRCODE = 'check_violation';
       END IF;
       RETURN NULL;
     END;
   $fn$ LANGUAGE plpgsql`,

  `CREATE CONSTRAINT TRIGGER instrument_one_specialization
     AFTER INSERT ON instrument
     INITIALLY DEFERRED
     FOR EACH ROW EXECUTE FUNCTION spike_require_one_specialization()`,
];

/** Reference rows the harness TRUNCATE wipes before every test. */
const SEED: readonly string[] = [
  `INSERT INTO currency (code, name, symbol, minor_unit) VALUES ('BRL', 'Brazilian Real', 'R$', 2)`,
  `INSERT INTO instrument_type (code) VALUES ('EQUITY'), ('ETF'), ('FIXED_INCOME'), ('CRYPTO')`,
  `INSERT INTO exchange (code, name) VALUES ('B3', 'B3 S.A.')`,
];

interface ThrownLike {
  readonly code?: string;
  readonly message?: string;
  readonly meta?: { readonly code?: string };
}

/**
 * Assert an error carries a specific Postgres SQLSTATE. Prisma surfaces a raw
 * query failure as `Raw query failed. Code: \`23514\`. Message: ...`, so the
 * code is in the message; the driver-adapter path may also put it on
 * `.code` / `.meta.code`. Check all three.
 */
function expectSqlState(error: unknown, sqlState: string): void {
  const e = (error ?? {}) as ThrownLike;
  const haystack = JSON.stringify({
    code: e.code,
    metaCode: e.meta?.code,
    message: e.message,
  });
  expect(haystack).toContain(sqlState);
}

interface JoinedRow {
  readonly id: string;
  readonly instrument_type: string;
  readonly name: string;
  readonly ticker: string;
  readonly exchange_code: string;
  readonly spec_count: bigint;
}

describe('SPIKE (throwaway): instrument class-table inheritance in Prisma', () => {
  let moduleRef: TestingModule;
  let prisma: PrismaService;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [PrismaModule],
    }).compile();
    await moduleRef.init();
    prisma = moduleRef.get(PrismaService);

    for (const statement of DDL) {
      await prisma.$executeRawUnsafe(statement);
    }
  });

  afterAll(async () => {
    await moduleRef.close();
  });

  beforeEach(async () => {
    // Registered after the harness's TRUNCATE (setupFilesAfterEnv runs first),
    // so this re-seeds the reference rows it just wiped.
    for (const statement of SEED) {
      await prisma.$executeRawUnsafe(statement);
    }
  });

  /** base + specialization inside one transaction -- the atomic write. */
  async function createEquity(args: {
    id?: string;
    ownerUserId?: string | null;
    ticker: string;
    exchangeCode?: string;
  }): Promise<string> {
    const id = args.id ?? randomUUID();
    const owner = args.ownerUserId ?? null;
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(
        `INSERT INTO instrument (id, instrument_type, owner_user_id, name, currency_code, status, is_variable_income)
         VALUES ($1, 'EQUITY', $2, $3, 'BRL', 'ACTIVE', true)`,
        id,
        owner,
        `Equity ${args.ticker}`,
      );
      await tx.$executeRawUnsafe(
        `INSERT INTO instrument_equity (instrument_id, ticker, exchange_code)
         VALUES ($1, $2, $3)`,
        id,
        args.ticker,
        args.exchangeCode ?? 'B3',
      );
    });
    return id;
  }

  async function createCrypto(args: {
    id?: string;
    ownerUserId?: string | null;
    symbol: string;
    network: string | null;
  }): Promise<string> {
    const id = args.id ?? randomUUID();
    const owner = args.ownerUserId ?? null;
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(
        `INSERT INTO instrument (id, instrument_type, owner_user_id, name, currency_code, status, is_variable_income)
         VALUES ($1, 'CRYPTO', $2, $3, 'BRL', 'ACTIVE', true)`,
        id,
        owner,
        `Crypto ${args.symbol}`,
      );
      await tx.$executeRawUnsafe(
        `INSERT INTO instrument_crypto (instrument_id, symbol, network, decimals)
         VALUES ($1, $2, $3, 8)`,
        id,
        args.symbol,
        args.network,
      );
    });
    return id;
  }

  // --- Behaviour 1 -------------------------------------------------------------

  describe('behaviour 1: base + specialization as a 1:1 relation', () => {
    it('Prisma schema language expresses the hierarchy as 1:1 relations (prisma validate)', () => {
      const output = execFileSync(
        'npx',
        ['prisma', 'validate', '--schema', SPIKE_SCHEMA],
        { cwd: API_ROOT, encoding: 'utf8', stdio: 'pipe' },
      );
      expect(output).toContain('is valid');
    });

    it('creates base + specialization atomically and reads them back as one 1:1 row', async () => {
      const id = await createEquity({ ticker: 'PETR4' });

      const rows = await prisma.$queryRawUnsafe<JoinedRow[]>(
        `SELECT i.id, i.instrument_type, i.name,
                e.ticker, e.exchange_code,
                (SELECT count(*) FROM instrument_equity x WHERE x.instrument_id = i.id) AS spec_count
         FROM instrument i
         JOIN instrument_equity e ON e.instrument_id = i.id
         WHERE i.id = $1`,
        id,
      );

      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        id,
        instrument_type: 'EQUITY',
        name: 'Equity PETR4',
        ticker: 'PETR4',
        exchange_code: 'B3',
      });
      // 1:1: the shared PK means at most one specialization row per base row.
      expect(Number(rows[0]?.spec_count)).toBe(1);
    });
  });

  // --- Behaviour 2 -----------------------------------------------------------

  describe('behaviour 2: the database rejects a broken specialization', () => {
    it('rejects a specialization row that does not match the discriminator (raw SQL, no service layer)', async () => {
      const id = randomUUID();
      let caught: unknown;
      try {
        await prisma.$transaction(async (tx) => {
          await tx.$executeRawUnsafe(
            `INSERT INTO instrument (id, instrument_type, name, currency_code, status, is_variable_income)
             VALUES ($1, 'EQUITY', 'mismatch', 'BRL', 'ACTIVE', true)`,
            id,
          );
          // EQUITY base, FIXED_INCOME specialization -- the composite FK
          // (instrument_id, instrument_type) has no (id, 'FIXED_INCOME') to
          // point at.
          await tx.$executeRawUnsafe(
            `INSERT INTO instrument_fixed_income (instrument_id, issuer_name, indexation_type, maturity_date)
             VALUES ($1, 'Tesouro Nacional', 'IPCA', DATE '2030-01-01')`,
            id,
          );
        });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeDefined();
      expectSqlState(caught, '23503'); // foreign_key_violation

      // and nothing was left behind
      const count = await prisma.$queryRawUnsafe<{ n: bigint }[]>(
        `SELECT count(*)::bigint AS n FROM instrument WHERE id = $1`,
        id,
      );
      expect(Number(count[0]?.n)).toBe(0);
    });

    it('rejects an instrument with ZERO specialization rows (deferred trigger)', async () => {
      const id = randomUUID();
      let caught: unknown;
      try {
        await prisma.$transaction(async (tx) => {
          await tx.$executeRawUnsafe(
            `INSERT INTO instrument (id, instrument_type, name, currency_code, status, is_variable_income)
             VALUES ($1, 'EQUITY', 'orphan', 'BRL', 'ACTIVE', true)`,
            id,
          );
          // The constraint trigger is INITIALLY DEFERRED, so it would otherwise
          // only fire at COMMIT. Force it here so the failure surfaces as a
          // statement error carrying its SQLSTATE (a COMMIT-time failure
          // reaches Prisma as just the RAISE text). Either way the row never
          // lands.
          await tx.$executeRawUnsafe(`SET CONSTRAINTS ALL IMMEDIATE`);
        });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeDefined();
      expectSqlState(caught, '23514'); // check_violation, raised by the trigger
      expect((caught as ThrownLike).message).toMatch(
        /exactly one is required/,
      );

      const count = await prisma.$queryRawUnsafe<{ n: bigint }[]>(
        `SELECT count(*)::bigint AS n FROM instrument WHERE id = $1`,
        id,
      );
      expect(Number(count[0]?.n)).toBe(0);
    });

    it('rejects a SECOND specialization row of a different type', async () => {
      const id = await createEquity({ ticker: 'VALE3' });

      let caught: unknown;
      try {
        await prisma.$transaction(async (tx) => {
          await tx.$executeRawUnsafe(
            `INSERT INTO instrument_crypto (instrument_id, symbol, network, decimals)
             VALUES ($1, 'VALE', 'ETHEREUM', 8)`,
            id,
          );
        });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeDefined();
      expectSqlState(caught, '23503'); // composite FK: no (id, 'CRYPTO') on base
    });
  });

  // --- Behaviour 3 ---------------------------------------------------------

  describe('behaviour 3: partial unique index on the public natural key', () => {
    it('lets two different users each hold a private equity with the same (exchange_code, ticker)', async () => {
      const userA = randomUUID();
      const userB = randomUUID();

      await expect(
        createEquity({ ownerUserId: userA, ticker: 'MGLU3' }),
      ).resolves.toBeDefined();
      await expect(
        createEquity({ ownerUserId: userB, ticker: 'MGLU3' }),
      ).resolves.toBeDefined();

      // both rows carry the trigger-synced owner and so are outside the index
      const priv = await prisma.$queryRawUnsafe<{ n: bigint }[]>(
        `SELECT count(*)::bigint AS n FROM instrument_equity
         WHERE ticker = 'MGLU3' AND owner_user_id IS NOT NULL`,
      );
      expect(Number(priv[0]?.n)).toBe(2);
    });

    it('rejects a SECOND public equity with the same (exchange_code, ticker)', async () => {
      await createEquity({ ownerUserId: null, ticker: 'ITUB4' });

      let caught: unknown;
      try {
        await createEquity({ ownerUserId: null, ticker: 'ITUB4' });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeDefined();
      expectSqlState(caught, '23505'); // unique_violation, partial index
    });

    it('applies the same rule to crypto (symbol, network): private duplicates allowed, second public rejected', async () => {
      const userA = randomUUID();
      const userB = randomUUID();

      await expect(
        createCrypto({ ownerUserId: userA, symbol: 'USDC', network: 'ETHEREUM' }),
      ).resolves.toBeDefined();
      await expect(
        createCrypto({ ownerUserId: userB, symbol: 'USDC', network: 'ETHEREUM' }),
      ).resolves.toBeDefined();

      await createCrypto({ ownerUserId: null, symbol: 'USDC', network: 'ETHEREUM' });

      let caught: unknown;
      try {
        await createCrypto({
          ownerUserId: null,
          symbol: 'USDC',
          network: 'ETHEREUM',
        });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeDefined();
      expectSqlState(caught, '23505');
    });
  });
});
