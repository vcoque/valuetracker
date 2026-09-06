import { randomBytes } from 'node:crypto';

import type { PrismaClient } from '@prisma/client';

import {
  adminUrl,
  createPrismaClient,
  templateDatabaseName,
  testContainerUrl,
  truncateAllTables,
  withDatabase,
} from './database';

/**
 * Per-test-file harness, wired in as `setupFilesAfterEnv` for the integration
 * and e2e projects. It gives every test file its own database, and every test
 * within that file an empty one.
 *
 * Two separate problems, two separate mechanisms:
 *
 * A database per *file*, because Jest runs test files in parallel workers. With
 * a single shared database, one file's clean-up TRUNCATE deletes another file's
 * rows mid-test. That failure is intermittent, depends on worker scheduling, and
 * reads like a bug in the code under test -- so it is designed out here rather
 * than debugged later.
 *
 * A TRUNCATE before each *test*, because tests within one file share their
 * file's database. Starting every test from empty is stronger than "clean up
 * after yourself": a test that forgets to, or one that fails halfway through,
 * cannot leave rows that make the next test pass for the wrong reason. It also
 * means tests may be read in any order, since none inherits state from the one
 * before it.
 *
 * Cloning is why this is affordable. `CREATE DATABASE ... TEMPLATE` is a file
 * copy of an already-migrated database, so a file pays a copy rather than a full
 * migration history.
 */

let client: PrismaClient | undefined;
let databaseName: string | undefined;

/** Runs a statement that cannot execute inside the database it targets. */
async function onAdminConnection(statement: string): Promise<void> {
  const admin = createPrismaClient(adminUrl());

  try {
    await admin.$executeRawUnsafe(statement);
  } finally {
    await admin.$disconnect();
  }
}

/**
 * PostgreSQL refuses to clone a database while another session is connected to
 * it (SQLSTATE 55006), and test files start in parallel, so two of them can ask
 * to clone the template at the same moment. The window is small -- nothing holds
 * a connection to the template for long -- but "small" and "never" are different
 * things, and a harness that is itself flaky teaches people to re-run tests
 * instead of reading them. Retrying is the correct response: the condition is
 * transient by definition.
 */
async function cloneTemplateDatabase(target: string): Promise<void> {
  const statement = `CREATE DATABASE "${target}" TEMPLATE "${templateDatabaseName()}"`;
  const attempts = 10;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      await onAdminConnection(statement);
      return;
    } catch (error) {
      const isTemplateBusy =
        error instanceof Error &&
        /being accessed by other users|55006/.test(error.message);

      if (!isTemplateBusy || attempt === attempts) {
        throw error;
      }

      await new Promise((resolve) => setTimeout(resolve, 100 * attempt));
    }
  }
}

beforeAll(async () => {
  // Random rather than derived from JEST_WORKER_ID: worker ids are reused as
  // files finish, so two files could collide on one name within a single run.
  databaseName = `vt_test_${randomBytes(6).toString('hex')}`;

  await cloneTemplateDatabase(databaseName);

  const databaseUrl = withDatabase(testContainerUrl(), databaseName);

  // The application's own ConfigModule reads DATABASE_URL, so setting it here
  // is what lets a Nest module under test reach this file's database with no
  // test-only override anywhere in the application code.
  process.env.DATABASE_URL = databaseUrl;

  client = createPrismaClient(databaseUrl);
});

beforeEach(async () => {
  if (client) {
    await truncateAllTables(client);
  }
});

afterAll(async () => {
  await client?.$disconnect();
  client = undefined;

  if (databaseName) {
    // WITH (FORCE) because a test that leaves a connection open would otherwise
    // block the drop and leak a database for the rest of the run.
    await onAdminConnection(
      `DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`,
    );
    databaseName = undefined;
  }
});
