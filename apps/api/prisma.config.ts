// Prisma CLI configuration -- `migrate`, `generate`, `db seed`.
//
// Prisma 7 removed `url` from the datasource block in schema.prisma, so this is
// now the only place the CLI learns where the database is. It governs
// developer and CI tooling exclusively; the running application builds its own
// connection from the validated config in src/shared/config and never reads
// this file.
//
// `env()` is Prisma's own accessor rather than a bare process.env read: it
// throws a named PrismaConfigEnvError when the variable is missing, so a
// mis-set environment fails as "DATABASE_URL is not set" instead of as a
// connection attempt to `undefined`. `datasourceUrl()` below catches that one
// throw for the `generate`/no-database case -- see its own doc comment for
// the full behavior of each Prisma CLI command when the variable is unset.

import { defineConfig, env } from 'prisma/config';

/**
 * The datasource URL for the commands that actually connect -- `migrate`,
 * `db`, `studio`.
 *
 * `generate` also loads this file, and it runs from `apps/api`'s `postinstall`
 * hook. A bare `npm ci` -- CI's install step before Postgres is provisioned, a
 * future production image build on compiled output -- has no database and no
 * `DATABASE_URL`. `generate` never reads the datasource URL (it only needs the
 * schema), so a missing variable must not fail install.
 *
 * `env()` throws `PrismaConfigEnvError` the instant the variable is unset,
 * which is right for a real datasource command and wrong for codegen. Catch
 * that one case and fall back to an obviously-non-connecting placeholder:
 * `generate` ignores it, and `migrate`/`db`/`studio` still fail loudly -- now
 * as a connection error against `unset:unset@127.0.0.1:1/unset`, which names
 * its own cause -- whenever the URL was genuinely required and absent.
 *
 * This stays the single source of the CLI connection string, and `env()`
 * remains its only reader: no raw `process.env` access enters the file.
 */
function datasourceUrl(): string {
  try {
    return env('DATABASE_URL');
  } catch {
    return 'postgresql://unset:unset@127.0.0.1:1/unset';
  }
}

export default defineConfig({
  schema: 'prisma/schema.prisma',
  datasource: {
    url: datasourceUrl(),
  },
  migrations: {
    // Prisma 7 replaced the legacy `package.json#prisma.seed` with this field.
    // Node 24 strips the types in `prisma/seed.ts` natively -- no ts-node or
    // tsx, no new dependency. `--disable-warning` silences the one-off
    // MODULE_TYPELESS_PACKAGE_JSON notice Node prints when it re-parses an
    // extensionless-package `.ts` file as an ES module.
    seed: 'node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON prisma/seed.ts',
  },
});
