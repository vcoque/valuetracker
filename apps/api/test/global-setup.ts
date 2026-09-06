import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';

import { TEST_CONTAINER_URL_VAR } from './database';

/**
 * Starts one throwaway PostgreSQL for the whole test run and migrates it.
 *
 * This runs inside the toolchain container, which shares the host's docker
 * socket, so the database it starts is a *sibling* of this container rather than
 * a child. Siblings publish their ports on the host, which is why
 * `TESTCONTAINERS_HOST_OVERRIDE` is set in `compose-dev.yaml` -- without it the
 * client dials a port inside its own network namespace and hangs. Task 1 proved
 * that path; this is the first thing to actually depend on it.
 *
 * It is declared on the `integration` and `e2e` projects rather than at the root
 * of `jest.config.ts`, and that placement is load-bearing: a root-level hook runs
 * for *every* invocation, so `npm test -- --selectProjects unit` would pay five
 * seconds of container startup to run tests that never touch a database. Jest
 * collects global hooks into a set keyed by module path, so naming the same file
 * on both database-backed projects still starts exactly one container.
 */

const API_ROOT = resolve(dirname(__filename), '..');

/**
 * The image is not hardcoded. `compose-dev.yaml` passes the same POSTGRES_IMAGE
 * the development database uses, so the two cannot drift on to different
 * PostgreSQL versions -- which is exactly how a constraint passes locally and
 * fails in CI.
 */
function postgresImage(): string {
  const image = process.env.POSTGRES_IMAGE;

  if (!image) {
    throw new Error(
      'POSTGRES_IMAGE is not set. Run the suite through ./scripts/dev.sh, ' +
        'which passes it from .env.dev.',
    );
  }

  return image;
}

async function startAndMigrate(): Promise<StartedPostgreSqlContainer> {
  const container = await new PostgreSqlContainer(postgresImage()).start();

  // `prisma migrate deploy` -- never `migrate dev` -- so the tests exercise the
  // committed migration files exactly as a deployment would apply them. A
  // migration that only works when Prisma regenerates it is a broken migration.
  execFileSync('npx', ['prisma', 'migrate', 'deploy'], {
    cwd: API_ROOT,
    env: { ...process.env, DATABASE_URL: container.getConnectionUri() },
    stdio: 'inherit',
  });

  return container;
}

/**
 * Jest already deduplicates global hooks by module path, so this would run once
 * even without the guard. Keeping it makes "exactly one container" a property of
 * this file rather than an assumption about Jest's internals -- and a second
 * container would be silent, not loud: the run would simply migrate twice and
 * leave one database orphaned.
 */
let startup: Promise<StartedPostgreSqlContainer> | undefined;

export default async function globalSetup(): Promise<void> {
  startup ??= startAndMigrate();

  const container = await startup;

  // Workers are forked after this returns, so they inherit these.
  process.env[TEST_CONTAINER_URL_VAR] = container.getConnectionUri();

  // DATABASE_URL is repointed at the throwaway server *before any worker
  // starts*, and this is a safety property rather than a convenience. Inside the
  // toolchain container it otherwise still names the development database from
  // compose-dev.yaml, so any code reading it at module-evaluation time -- before
  // the beforeAll hook below has narrowed it to a per-file database -- would
  // connect to real development data and, worse, would succeed. Overwriting it
  // here means the worst case is a test writing to the throwaway template, not
  // to the developer's database.
  process.env.DATABASE_URL = container.getConnectionUri();

  globalThis.__VALUETRACKER_PG_CONTAINER__ = container;
}
