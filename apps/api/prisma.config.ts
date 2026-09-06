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
// connection attempt to `undefined`.

import { defineConfig, env } from 'prisma/config';

export default defineConfig({
  schema: 'prisma/schema.prisma',
  datasource: {
    url: env('DATABASE_URL'),
  },
});
