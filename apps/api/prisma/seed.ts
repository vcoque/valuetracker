// Reference-data seed for the `catalog` module: ISO 4217 currencies, the B3
// trading venue, and one price data source.
//
// Wired for Prisma 7 through `migrations.seed` in ../prisma.config.ts, which
// runs it as `node --disable-warning=... prisma/seed.ts`. Node 24 strips the
// types natively, so no ts-node / tsx is needed and no dependency is added.
//
// This is a standalone CLI script, not part of the Nest application: it has no
// AppConfig to inject, so it reads the connection string from the environment
// the way `prisma db seed`, `prisma migrate reset` and the CI harness all
// provide it. The reusable part is `seedReferenceData`, which the integration
// suite runs against a throwaway database.
//
// Idempotent by construction: every write is an `upsert` keyed on the table's
// natural or unique key, so running the seed any number of times converges on
// the same rows.

import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';

const CURRENCIES = [
  { code: 'BRL', name: 'Brazilian Real', symbol: 'R$', minorUnit: 2 },
  { code: 'USD', name: 'US Dollar', symbol: '$', minorUnit: 2 },
  { code: 'EUR', name: 'Euro', symbol: '€', minorUnit: 2 },
] as const;

const EXCHANGES = [
  {
    code: 'B3',
    name: 'B3 - Brasil, Bolsa, Balcão',
    countryCode: 'BR',
    currencyCode: 'BRL',
    timezone: 'America/Sao_Paulo',
  },
] as const;

const DATA_SOURCES = [
  {
    name: 'B3_EOD',
    description: 'B3 official end-of-day equity and fund quotes',
    priority: 1,
    isActive: true,
  },
] as const;

export async function seedReferenceData(prisma: PrismaClient): Promise<void> {
  for (const currency of CURRENCIES) {
    await prisma.currency.upsert({
      where: { code: currency.code },
      update: currency,
      create: currency,
    });
  }

  for (const exchange of EXCHANGES) {
    await prisma.exchange.upsert({
      where: { code: exchange.code },
      update: exchange,
      create: exchange,
    });
  }

  for (const dataSource of DATA_SOURCES) {
    await prisma.dataSource.upsert({
      where: { name: dataSource.name },
      update: dataSource,
      create: dataSource,
    });
  }
}

async function main(): Promise<void> {
  // This is a standalone seed CLI run outside the Nest app by `prisma db seed`;
  // Prisma exposes the datasource only through the environment, and there is no
  // AppConfig here to read it from.
  // eslint-disable-next-line no-restricted-properties -- see comment above
  const databaseUrl = process.env.DATABASE_URL;

  if (!databaseUrl) {
    throw new Error(
      'DATABASE_URL is not set. `prisma db seed` needs it to reach the database.',
    );
  }

  const prisma = new PrismaClient({ adapter: new PrismaPg(databaseUrl) });

  try {
    await seedReferenceData(prisma);
    console.log('Seed complete: 3 currencies, 1 exchange, 1 data source.');
  } finally {
    await prisma.$disconnect();
  }
}

// Run the connect-and-write path only when this file is the process entry point
// (`prisma db seed` -> `node prisma/seed.ts`). When a test imports
// `seedReferenceData`, the entry point is the test runner, so `main` stays
// dormant and no connection is opened on import. `process.argv[1]` is portable
// across CommonJS and ES module execution, unlike `require.main`/`import.meta`.
if (process.argv[1]?.endsWith('seed.ts') ?? false) {
  void main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
