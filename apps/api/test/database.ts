import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';

/**
 * Connection helpers shared by the integration and e2e harnesses.
 *
 * The database these talk to is a throwaway container started in
 * `global-setup.ts`, never the `db` service from `compose-dev.yaml` -- a test
 * run cannot corrupt development data.
 */

/** Set by `global-setup.ts` once the throwaway container is listening. */
export const TEST_CONTAINER_URL_VAR = 'VT_TEST_CONTAINER_URL';

/**
 * The connection string for the throwaway container's own database, which the
 * harness uses as a migrated template rather than as a place to store rows.
 *
 * It is deliberately kept in its own variable rather than only in
 * `DATABASE_URL`: a test that accidentally picked up the *development* database
 * would still pass, quietly writing to it, and nobody would find out until the
 * dev data was gone. If this is missing the harness did not run, and failing
 * loudly here is the whole point.
 */
export function testContainerUrl(): string {
  const url = process.env[TEST_CONTAINER_URL_VAR];

  if (!url) {
    throw new Error(
      `${TEST_CONTAINER_URL_VAR} is not set. The Testcontainers harness in ` +
        'apps/api/test/global-setup.ts did not run -- check jest.config.ts.',
    );
  }

  return url;
}

/** The same server, a different database on it. */
export function withDatabase(url: string, databaseName: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${databaseName}`;
  return parsed.toString();
}

/** The database `global-setup.ts` migrated; every test database clones it. */
export function templateDatabaseName(): string {
  return new URL(testContainerUrl()).pathname.replace(/^\//, '');
}

/**
 * A connection to the server's built-in `postgres` database, used only to
 * CREATE and DROP test databases. It has to be a database other than the
 * template, because PostgreSQL refuses to clone a database that has an open
 * connection.
 */
export function adminUrl(): string {
  return withDatabase(testContainerUrl(), 'postgres');
}

/** A client for an arbitrary database on the throwaway server. */
export function createPrismaClient(url: string): PrismaClient {
  return new PrismaClient({ adapter: new PrismaPg(url) });
}

interface TableRow {
  readonly tablename: string;
}

/**
 * Empty every table, leaving the schema and the migration history intact.
 *
 * Each test *file* already gets its own database, so this exists for the tests
 * *within* one file. TRUNCATE rather than re-cloning: it is a single fast
 * statement, where recreating the database between tests would pay the clone
 * cost per test rather than per file. CASCADE handles foreign keys without
 * needing to know the dependency order, and RESTART IDENTITY keeps generated
 * keys from drifting upward across tests, which would otherwise make an
 * assertion on an id depend on how many tests ran before it.
 */
export async function truncateAllTables(client: PrismaClient): Promise<void> {
  const tables = await client.$queryRaw<TableRow[]>`
    SELECT tablename
    FROM pg_tables
    WHERE schemaname = 'public'
      AND tablename <> '_prisma_migrations'
  `;

  if (tables.length === 0) {
    return;
  }

  const quoted = tables
    .map(({ tablename }) => `"public"."${tablename.replace(/"/g, '""')}"`)
    .join(', ');

  await client.$executeRawUnsafe(
    `TRUNCATE TABLE ${quoted} RESTART IDENTITY CASCADE`,
  );
}
