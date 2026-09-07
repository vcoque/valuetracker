import { Test, type TestingModule } from '@nestjs/testing';

import { seedReferenceData } from '../../../prisma/seed';
import { PrismaModule } from '../../shared/prisma/prisma.module';
import { PrismaService } from '../../shared/prisma/prisma.service';

/**
 * Structural invariants owned by the `catalog` reference tables, asserted at the
 * database rather than through the ORM: a foreign key and a unique key are only
 * real if PostgreSQL is the one enforcing them. Also proves the seed is
 * idempotent -- running its logic twice leaves exactly the same rows.
 *
 * `seedReferenceData` is imported straight from `prisma/seed.ts` (its
 * connect-and-run wrapper stays dormant unless that file is the process entry
 * point), so the test drives the exact code `prisma db seed` runs.
 */
describe('catalog reference data (integration)', () => {
  let moduleRef: TestingModule;
  let prisma: PrismaService;

  beforeEach(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [PrismaModule],
    }).compile();
    await moduleRef.init();
    prisma = moduleRef.get(PrismaService);
  });

  afterEach(async () => {
    await moduleRef.close();
  });

  it('rejects an exchange whose currency_code has no currency row (FK, 23503)', async () => {
    const insert = prisma.$executeRawUnsafe(
      `INSERT INTO "exchange" ("code", "name", "country_code", "currency_code", "timezone")
       VALUES ('XX', 'Nowhere Exchange', 'ZZ', 'QQQ', 'Etc/UTC')`,
    );

    await expect(insert).rejects.toMatchObject({
      meta: {
        driverAdapterError: {
          cause: {
            kind: 'ForeignKeyConstraintViolation',
            originalCode: '23503',
          },
        },
      },
    });
  });

  it('rejects a second data_source with a duplicate name (unique key, 23505)', async () => {
    await prisma.$executeRawUnsafe(
      `INSERT INTO "data_source" ("name", "priority", "is_active")
       VALUES ('DUP_SOURCE', 1, true)`,
    );

    const second = prisma.$executeRawUnsafe(
      `INSERT INTO "data_source" ("name", "priority", "is_active")
       VALUES ('DUP_SOURCE', 2, false)`,
    );

    await expect(second).rejects.toMatchObject({
      meta: {
        driverAdapterError: {
          cause: {
            kind: 'UniqueConstraintViolation',
            originalCode: '23505',
          },
        },
      },
    });
  });

  it('migrated the documented columns for exchange and data_source', async () => {
    const columns = await prisma.$queryRawUnsafe<
      { table_name: string; column_name: string; is_nullable: string }[]
    >(
      `SELECT table_name, column_name, is_nullable
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name IN ('exchange', 'data_source')
       ORDER BY table_name, column_name`,
    );

    const shape = columns.map(
      (c) => `${c.table_name}.${c.column_name}:${c.is_nullable}`,
    );

    expect(shape).toEqual([
      'data_source.description:YES',
      'data_source.id:NO',
      'data_source.is_active:NO',
      'data_source.name:NO',
      'data_source.priority:NO',
      'exchange.code:NO',
      'exchange.country_code:NO',
      'exchange.currency_code:NO',
      'exchange.name:NO',
      'exchange.timezone:NO',
    ]);
  });

  it('seeds BRL/USD/EUR, the B3 exchange and a data source, idempotently', async () => {
    await seedReferenceData(prisma);

    const after1 = {
      currencies: await prisma.currency.count(),
      exchanges: await prisma.exchange.count(),
      dataSources: await prisma.dataSource.count(),
    };

    expect(after1).toEqual({ currencies: 3, exchanges: 1, dataSources: 1 });

    await seedReferenceData(prisma);

    const after2 = {
      currencies: await prisma.currency.count(),
      exchanges: await prisma.exchange.count(),
      dataSources: await prisma.dataSource.count(),
    };

    expect(after2).toEqual(after1);

    const b3 = await prisma.exchange.findUnique({ where: { code: 'B3' } });
    expect(b3).toMatchObject({
      code: 'B3',
      countryCode: 'BR',
      currencyCode: 'BRL',
      timezone: 'America/Sao_Paulo',
    });

    const dataSource = await prisma.dataSource.findUnique({
      where: { name: 'B3_EOD' },
    });
    expect(dataSource).toMatchObject({ priority: 1, isActive: true });
  });
});
