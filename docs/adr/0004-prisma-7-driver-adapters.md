# ADR 0004 — Prisma 7 connects through a driver adapter, not a datasource URL

- **Status:** Accepted
- **Date:** 2026-09-06
- **Amends:** `SPEC.md` §Tech Stack and §Commands

## Context

`SPEC.md` pins Prisma to **7.10.0**, chosen against the npm registry because
`prisma@latest` resolves to an 8.0 release candidate. The pin is right. What the
spec did not capture is that Prisma 7 is not Prisma 6 with a higher number —
it changes how an application connects to its database, and Task 4 is the first
task that had to connect.

Three things broke against the spec's assumptions:

1. **`url` is no longer allowed in the `datasource` block.** `prisma validate`
   rejects it outright:

   > The datasource property `url` is no longer supported in schema files. Move
   > connection URLs for Migrate to `prisma.config.ts`.

2. **There is no Rust query engine.** `prisma --version` reports
   `Query Compiler : enabled`. Queries are compiled and executed through a
   **driver adapter** — an ordinary Node database driver that the application
   supplies. Without one, `PrismaClient` has no way to reach PostgreSQL.

3. **The CLI and the application now read configuration from different places.**
   `migrate` and `generate` read `prisma.config.ts`; the client reads whatever
   the application hands its constructor.

None of this is optional or deferrable. It is the only way Prisma 7 connects.

## Decision

**Adopt `@prisma/adapter-pg` (7.10.0) as a runtime dependency of `apps/api`,
and give the CLI its own `prisma.config.ts`.**

```
apps/api/prisma.config.ts     CLI only: migrate, generate, db seed
apps/api/prisma/schema.prisma datasource declares `provider`, never `url`
PrismaService                 new PrismaPg(config.databaseUrl)
```

`@prisma/adapter-pg` bundles `pg`, so this adds one direct dependency rather
than two.

`SPEC.md` §Boundaries lists "adding a runtime dependency" under *Ask first*.
This was raised and approved rather than assumed.

## Consequences

**The separation the spec wanted came for free.** `SPEC.md` §Boundaries requires
`DATABASE_URL` to be read through validated typed config and never from
`process.env` directly. Under Prisma 6 that rule fought the tool, which wanted to
resolve `env("DATABASE_URL")` itself. Under Prisma 7 the client *must* be handed
a connection string, so the rule and the tool now agree:
`AppConfig` validates the URL with zod, `PrismaService` receives it by injection,
and `eslint.config.mjs` fails the build on any `process.env` read in application
code outside `src/shared/config`.

**Tests can point the same service at a throwaway database with no test-only
code path.** Because the URL arrives by injection and `ConfigModule` reads the
environment once, the integration harness repoints `DATABASE_URL` and the
production wiring does the rest. There is no test-only branch inside
`PrismaService` — what the tests exercise is what runs.

**Two configuration surfaces must not drift.** `prisma.config.ts` governs
migrations; `AppConfig` governs the running client. They read the same variable,
but nothing forces them to. A future environment that migrates against one
database and runs against another will not fail loudly. Worth revisiting if a
second environment appears.

**Prisma's own advisories are inherited.** `npm audit` reports four
high-severity findings, all transitive dependencies of the Prisma **CLI**
(`@prisma/config` → `deepmerge-ts`, and the unused `mysql2` driver adapter).
None is reachable from `@prisma/client` at runtime, and none is reachable at all
on PostgreSQL. The only offered fix downgrades to `prisma@6.19.3`, which would
break the pin and undo this ADR. Accepted, and to be revisited when Prisma
updates those transitives.

## Alternatives considered

**Downgrade to Prisma 6 to keep the familiar `url` datasource.** Rejected. It
trades a one-file change for a major-version regression on the project's ORM,
and `SPEC.md` §Version traps pinned 7.10.0 against evidence rather than taste.

**Use `@prisma/adapter-pg`'s pool configuration instead of a connection
string.** Deferred. A `pg.Pool` would let the application tune pool size and
timeouts, which will matter under load. It is a strictly additive change —
`PrismaPg` accepts a `Pool` where it currently accepts a string — so it can wait
until there is a measurement to tune against.

**Keep a single `prisma.config.ts` and have the application read it too.**
Rejected. It would drag the Prisma CLI's configuration loader into the runtime
process, and it inverts the dependency: application configuration is broader
than Prisma's, not a subset of it.
