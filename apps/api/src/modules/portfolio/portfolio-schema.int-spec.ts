import { randomUUID } from 'node:crypto';

import { Test, type TestingModule } from '@nestjs/testing';
import { Prisma } from '@prisma/client';

import { foreignKeyViolation, uniqueViolation } from '../../../test/pg-error';
import { PrismaModule } from '../../shared/prisma/prisma.module';
import { PrismaService } from '../../shared/prisma/prisma.service';

/**
 * Structural invariants owned by the `portfolio` table, asserted at the
 * database rather than through the ORM (`SPEC.md` §Testing Strategy).
 *
 * `SPEC-portfolio.md` acceptance criteria exercised here:
 *  - `base_currency_code` is FK-validated against `currency`;
 *  - `(user_id, name)` is unique -- one user cannot own two portfolios with
 *    the same name -- and the constraint does NOT collide across users.
 *
 * The unique constraint is Task 12's stated responsibility, but this task's
 * migration adds it now (cheap and additive -- see `task-11-report.md`), so
 * it is proven here rather than left unverified until Task 12.
 */
describe('portfolio schema (integration)', () => {
  let moduleRef: TestingModule;
  let prisma: PrismaService;

  const currencyCode = 'BRL';

  beforeEach(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [PrismaModule],
    }).compile();
    await moduleRef.init();
    prisma = moduleRef.get(PrismaService);

    await prisma.currency.create({
      data: { code: currencyCode, name: 'Brazilian Real', symbol: 'R$', minorUnit: 2 },
    });
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

  it('rejects a portfolio whose base_currency_code has no currency row (FK, 23503)', async () => {
    const user = await createUser('owner@example.com');

    const insert = prisma.$executeRawUnsafe(
      `INSERT INTO "portfolio" ("user_id", "name", "base_currency_code")
       VALUES ('${user.id}', 'No Currency', 'ZZZ')`,
    );

    await expect(insert).rejects.toMatchObject(foreignKeyViolation);
  });

  it('rejects a portfolio for a non-existent user (FK, 23503)', async () => {
    const insert = prisma.$executeRawUnsafe(
      `INSERT INTO "portfolio" ("user_id", "name", "base_currency_code")
       VALUES ('${randomUUID()}', 'Orphan', '${currencyCode}')`,
    );

    await expect(insert).rejects.toMatchObject(foreignKeyViolation);
  });

  it('rejects a second portfolio with the same name for the same user (unique constraint, 23505)', async () => {
    const user = await createUser('dup-name@example.com');

    await prisma.portfolio.create({
      data: { userId: user.id, name: 'Retirement', baseCurrencyCode: currencyCode },
    });

    const second = prisma.$executeRawUnsafe(
      `INSERT INTO "portfolio" ("user_id", "name", "base_currency_code")
       VALUES ('${user.id}', 'Retirement', '${currencyCode}')`,
    );

    await expect(second).rejects.toMatchObject(uniqueViolation);
  });

  it('does not collide the (user_id, name) constraint across different users', async () => {
    const userA = await createUser('a@example.com');
    const userB = await createUser('b@example.com');

    await prisma.portfolio.create({
      data: { userId: userA.id, name: 'Retirement', baseCurrencyCode: currencyCode },
    });

    const forB = await prisma.portfolio.create({
      data: { userId: userB.id, name: 'Retirement', baseCurrencyCode: currencyCode },
    });

    expect(forB.name).toBe('Retirement');
    expect(forB.userId).toBe(userB.id);
  });

  it('stores target_amount as an exact NUMERIC, not a float', async () => {
    const user = await createUser('numeric@example.com');

    const portfolio = await prisma.portfolio.create({
      data: {
        userId: user.id,
        name: 'Precision Check',
        baseCurrencyCode: currencyCode,
        targetAmount: new Prisma.Decimal('12345.6789'),
      },
    });

    expect(portfolio.targetAmount?.toFixed(4)).toBe('12345.6789');
  });

  it('migrated the documented columns for portfolio', async () => {
    const columns = await prisma.$queryRawUnsafe<
      { column_name: string; is_nullable: string }[]
    >(
      `SELECT column_name, is_nullable
       FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'portfolio'
       ORDER BY column_name`,
    );

    const shape = columns.map((c) => `${c.column_name}:${c.is_nullable}`);

    expect(shape).toEqual([
      'archived_at:YES',
      'base_currency_code:NO',
      'created_at:NO',
      'description:YES',
      'id:NO',
      'name:NO',
      'objective:YES',
      'target_amount:YES',
      'target_date:YES',
      'user_id:NO',
    ]);
  });
});
