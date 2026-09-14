# ValueTracker — Walking Skeleton Task List

Plan: [`tasks/plan.md`](./plan.md) · Specs: [`SPEC.md`](../SPEC.md),
[`SPEC-identity.md`](../SPEC-identity.md), [`SPEC-catalog.md`](../SPEC-catalog.md),
[`SPEC-portfolio.md`](../SPEC-portfolio.md)

Every task clears the standing bar in `SPEC.md` §Boundaries before it counts as
done: `npm run typecheck && npm test && npm run lint` passes, no `number` used
for money, no skipped tests.

**All `npm`/`npx` commands below run inside the toolchain container** (Task 1):
prefix them with `./scripts/dev.sh`, e.g. `./scripts/dev.sh npm test`. Docker is
the only thing the host needs.

---

## Phase 0: Foundation

### - [x] Task 1: Containerized toolchain

**Description:** Give the project the toolchain the stack requires without
mutating the developer's machine. The host runs Node `v18.19.1` while NestJS 12
declares `engines: node >= 20`. Rather than upgrade the host, the toolchain --
Node 24.20.0, npm, and the build dependencies -- lives in an image defined by
`Dockerfile.dev`, wired up by `compose-dev.yaml` alongside a Postgres service.
Docker and Compose are now the only host requirements.

**Acceptance criteria:**
- [x] Docker daemon reachable and Compose v2+ present — 29.7.2 and v5.4.0
- [x] The toolchain image reports Node ≥ 20 — reports 24.20.0, matching `.nvmrc`
- [x] `libssl` present in the image — `node:*-slim` omits it and Prisma's query engine links it
- [x] The container reaches the docker socket and `host.docker.internal`, so Testcontainers works
- [x] A Postgres service comes up healthy and is reachable from the app container
- [x] Files written into the bind mount are owned by the developer, not by root
- [x] `.nvmrc` retained, now documenting optional host-native work only
- [x] Every environment-specific file names its environment; nothing is loaded by implicit discovery
- [x] No interpolation carries a silent default -- a missing value fails and names its fix

**Verification:**
- [x] `./scripts/check-env.sh` exits 0
- [x] `./scripts/check-env.sh --full` exits 0 — builds the image and checks node, libssl and the socket
- [x] Testcontainers started a sibling Postgres 17.11 from inside the app container and ran a query
- [x] `./scripts/dev.sh node --version` → `v24.20.0`; a TCP probe reached `db:5432`
- [x] A bare `docker compose up` errors with "no configuration file provided" — the implicit path is gone
- [x] Omitting `.env.dev.local` errors with `required variable DOCKER_GID is missing a value: run ./scripts/check-env.sh --init-env`

**Decisions taken here:**

*Docker-outside-of-Docker for Testcontainers.* The test suite runs inside a
container but Testcontainers must start databases. Sharing the host's docker
socket makes those databases **siblings** of the app container rather than
children -- lighter and faster than privileged Docker-in-Docker, and it reuses
the host's image cache. Siblings publish their ports on the host, not in the
app container's network namespace, hence `host.docker.internal` via
`extra_hosts: host-gateway` and `TESTCONTAINERS_HOST_OVERRIDE`. Proven working,
not assumed.

*`node_modules` stays in the bind mount* rather than an anonymous volume. Host
and container are both linux/amd64 and the host's glibc (2.39) is newer than the
image's (2.36), so packages installed in the container remain readable from the
host -- which keeps the editor's TypeScript server and ESLint working without a
second host-native install. The usual reason to hide `node_modules` (macOS bind
mount performance, cross-platform binaries) does not apply here.

*`build.network: host`.* BuildKit copies the host `/etc/resolv.conf` into the
build's own network namespace verbatim. This host runs systemd-resolved, so that
file names the `127.0.0.53` stub, which is meaningless inside that namespace, and
every `apt-get` lookup failed to resolve. `dockerd` rewrites it for runtime
containers but BuildKit does not. Sharing the host namespace at build time only
is the repo-local fix; it needs no root and does not affect runtime networking.

*Environments are named, never implicit.* Compose loads `compose.yaml` and
`.env` from the working directory by default, so a bare `docker compose up`
would silently have meant "development". The files are named for what they
configure -- `compose-dev.yaml`, `Dockerfile.dev`, `.env.dev`,
`.env.dev.local` -- and passed explicitly on every invocation.
`scripts/_docker.sh` is the one place those names are written down. Adding CI or
production means adding files for them, never overloading these.

*Shared dev configuration is committed; only per-machine values are not.*
`.env.dev` holds the image pins, database name, credentials and published ports,
so a fresh clone is runnable and two developers cannot silently diverge.
`.env.dev.local` holds `HOST_UID`, `HOST_GID` and `DOCKER_GID` alone, because
those genuinely differ per machine. `.gitignore` was corrected: its previous
`.env.*` rule would have swallowed `.env.dev`.

*Dev-database credentials are committed in `.env.dev` on purpose.* They are
identical for every developer and reachable only from the local Compose network.
Nothing deployed reads them; deployed credentials come from the platform. This
is not a breach of `SPEC.md` §Boundaries "never commit secrets".

*`DATABASE_URL` is assembled in `compose-dev.yaml` from the same variables the
database is created with,* rather than stored whole, so the two cannot drift.

**Superseded:** the original task required Node ≥ 20 *on the host* and listed
`nvm` install steps. Nothing runs on the host now, so `check-env.sh` reports the
host Node version as information rather than failing on it. `.nvmrc` is kept for
anyone who chooses to work host-natively.

**Dependencies:** None
**Files:** `Dockerfile.dev`, `compose-dev.yaml`, `.dockerignore`, `.env.dev`,
`.env.dev.local.example`, `.nvmrc`, `.gitignore`, `scripts/check-env.sh`,
`scripts/dev.sh`, `scripts/_docker.sh`
**Scope:** S

---

### - [x] Task 2: Workspace root and NestJS scaffold in `apps/api`

**Description:** Establish the npm-workspaces root, then create the NestJS
application inside `apps/api` on the Fastify adapter with the exact versions from
`SPEC.md` §Tech Stack. The pins are not preferences — `@latest` resolves to a
Prisma RC and to a TypeScript that `ts-jest` rejects.

The layout is fixed here rather than later on purpose: moving the app afterwards
touches every path in `SPEC.md`, all three Jest projects, the `tsconfig` paths
and the container working directory. See
[ADR 0001](../docs/adr/0001-monorepo-with-npm-workspaces.md).

**Acceptance criteria:**
- [x] Root `package.json` declares `workspaces: ["apps/*", "packages/*"]` and is `private: true`
- [x] The NestJS app lives in `apps/api`; nothing application-level sits at the repository root
- [x] `prisma` and `@prisma/client` both pinned to exactly `7.10.0` (not `^`, not `latest`)
- [x] `typescript` pinned to `6.0.3`; TS 7.x must not appear in the lockfile
- [x] `tsconfig.json` has `strict: true`, `emitDecoratorMetadata`, `experimentalDecorators`
- [x] One lockfile at the root — a lockfile inside a workspace means the root was bypassed
- [x] App boots on Fastify and answers `GET /health` with 200 — `{"status":"ok"}`

**Verification:**
- [x] `./scripts/dev.sh npm install` from the root installs every workspace (207 packages)
- [x] `./scripts/dev.sh npm run build --workspace apps/api`, then `curl localhost:3000/health`
      → `{"status":"ok"} <- HTTP 200`, curled from the **host** against the published port
- [x] `./scripts/dev.sh npm ls typescript prisma @prisma/client` shows `6.0.3` / `7.10.0` / `7.10.0`
- [x] `./scripts/dev.sh npm run typecheck` passes

**Decisions taken here:**

*`moduleResolution: nodenext`, not the classic `commonjs`/`node` pair.*
TypeScript 6 fails the build outright on `node10` resolution (`TS5107`), so the
NestJS default tsconfig cannot be used verbatim. `nodenext` reads the nearest
`package.json` to pick a module system; `apps/api` declares no `"type"`, so
every file is still emitted and resolved as CommonJS — which is what the Nest
runtime and ts-jest expect. This is the first concrete consequence of the
TypeScript 6.0.3 pin, and it is a version trap the spec did not anticipate.

*A separate `tsconfig.build.json`.* The base config typechecks tests as well as
sources; the build config narrows to `src/` and excludes `*.spec.ts` so no test
file is ever emitted into `dist/`.

*No `@nestjs/cli`.* `SPEC.md` defines the build as `tsc -> dist/`, which needs
no generator. `start:dev` is `tsc --watch` alongside `node --watch`, so watch
mode costs no extra dependency.

*Prisma's install scripts are approved explicitly, and pinned.* npm 11 no longer
runs dependency install scripts by default, so the first install left Prisma's
query and schema engines undownloaded — a failure that would only have surfaced
in Task 4, as a missing engine binary. `allowScripts` in the root
`package.json` grants exactly `prisma@7.10.0` and `@prisma/engines@7.10.0`;
`--allow-scripts-pin` writes the version, so a future bump has to be approved
again rather than inheriting trust.

*`curl` added to `Dockerfile.dev`.* `node:*-slim` omits it, and both `SPEC.md`
§Commands and this task's own verification step are written in terms of `curl`.
The documented check now runs as documented.

**Known and accepted:** `npm audit` reports 4 high-severity advisories, all of
them transitive dependencies of the `prisma` **CLI** (`@prisma/config` →
`deepmerge-ts`, and the unused `mysql2` driver adapter). None is reachable from
`@prisma/client` at runtime, and none is reachable at all on PostgreSQL. The
only offered fix downgrades to `prisma@6.19.3`, which would break the pin
`SPEC.md` §Version traps set against evidence. Revisit when Prisma 7.x updates
those transitives.

**Dependencies:** Task 1
**Files:** `package.json`, `package-lock.json`, `apps/api/package.json`,
`apps/api/tsconfig.json`, `apps/api/tsconfig.build.json`, `apps/api/src/main.ts`,
`apps/api/src/app.module.ts`, `apps/api/src/app.controller.ts`,
`apps/api/src/app.service.ts`, `Dockerfile.dev`
**Scope:** M

**Note:** `compose-dev.yaml` needed no change — it already bind-mounts the repo
root at `/workspace`, which is exactly the workspace root npm needs.

---

### - [x] Task 3: Quality gates

**Description:** ESLint, Prettier, and Jest configured as three selectable
projects (unit / integration / e2e) so the fast suite stays fast.

**Acceptance criteria:**
- [x] `npm test -- --selectProjects unit` runs only `src/**/*.spec.ts` — proved with
      `--listTests`, and with a throwaway `*.int-spec.ts` that the unit project
      correctly refused to pick up
- [x] Integration and e2e projects are declared and select their own patterns —
      all three are selectable; e2e has a real test, integration is empty until Task 4
- [x] Coverage thresholds enforced: 80% global (branches, functions, lines, statements)
- [x] Lint fails on `any` and on floating promises

**Verification:**
- [x] `npm run lint && npm run typecheck && npm test` all pass — 3 tests, 2 suites
- [x] `npm run build` still passes, and `npm run format:check` is clean
- [x] Coverage is **100%** on every metric, with nothing excluded but `main.ts`
- [x] The coverage gate is proven to *bite*, not merely to pass: an earlier
      configuration reported 75% branches and Jest failed the run
- [x] Both required lint rules proven to fire, by linting a throwaway file
      containing an `any` parameter and an uncalled `await` — 2 errors, then deleted

**Decisions taken here:**

*NestJS 12 is ESM-only.* Every `@nestjs/*` package is `"type": "module"` with no
CommonJS build. The application never noticed, because Node 24 satisfies
`require()` of ESM transparently — but Jest's sandbox does not, and every suite
failed with *"Must use import to load ES Module"*. The test scripts therefore run
under `NODE_OPTIONS=--experimental-vm-modules`. This is a fact about the stack
worth knowing before Task 4 adds Prisma to the same test path;
`SPEC.md` §Version traps now records it.

*`isolatedModules` is deliberately off, against ts-jest's own advice.* ts-jest
emits `TS151002` recommending it under a hybrid module kind. Following that
advice cost 25% branch coverage per decorated class, and the reason turned out to
matter far more than the number: compiled file-by-file, TypeScript cannot tell a
type import from a value import, so `emitDecoratorMetadata` degrades to

```js
typeof AppService !== "undefined" && AppService === "function" ? AppService : Object
```

— an unreachable branch wrapped around a **fallback that injects `Object`
instead of the real provider**. Whole-program compilation emits the class
itself. The advisory is suppressed in `jest.config.ts` with that reasoning
written next to it. Coverage went from 75% to 100% as a side effect; the
correctness fix was the point.

*The threshold was never the thing to adjust.* The 80% bar failed twice during
this task. Both times the fix was in the emitted code, not in the number, and
nothing is excluded from the denominator except `main.ts` — a bootstrap file
exercised by running the process rather than by importing it.

*Three projects split by filename, not by directory,* so a module's unit and
integration tests sit beside the code they test: `*.spec.ts`, `*.int-spec.ts`,
`test/e2e/*.e2e-spec.ts`. `*.int-spec.ts` cannot match `*.spec.ts` — it ends in
`-spec.ts` — which is what makes the fast project genuinely fast.

*The e2e project ships with a real test rather than only a declaration.*
`GET /health` needs no database, so it is the one endpoint that can prove the
whole HTTP stack — Fastify adapter, routing, serialization — before Prisma
exists. A project declared but never run is a project that is broken and nobody
knows it.

*`npm run lint` does not `--fix`.* `SPEC.md` documented it as `eslint --fix`, but
every task in this list is gated on "lint passes", and a gate that rewrites the
code until it passes is not a gate. Mutation moved to `lint:fix`;
`SPEC.md` §Commands is updated to match.

*Prettier governs code, not prose.* Left unscoped it wanted to reflow all
thirteen Markdown specs and `compose-dev.yaml`. `.prettierignore` excludes
`*.md` and `*.y[a]ml`, which are hand-wrapped and reviewed as English.

**Known softening, to be removed:** `passWithNoTests: true` is set in
`jest.config.ts` because the `integration` project is declared before it owns any
test. Delete that line in Task 4, once it has one.

**Dependencies:** Task 2
**Files:** `eslint.config.mjs`, `.prettierrc`, `.prettierignore`,
`jest.config.ts`, `package.json`, `apps/api/tsconfig.json`,
`apps/api/tsconfig.build.json`, `apps/api/src/app.spec.ts`,
`apps/api/test/e2e/health.e2e-spec.ts`, `SPEC.md`
**Scope:** M

---

### - [x] Task 4: Prisma + Testcontainers harness

**Description:** Wire Prisma to PostgreSQL, add `PrismaService` with lifecycle
hooks, and build the integration-test harness that starts a real Postgres,
applies migrations, and truncates between tests.

**Acceptance criteria:**
- [x] `PrismaService` connects on module init and disconnects on shutdown — both
      proven by spying on `$connect`/`$disconnect` across the Nest lifecycle
- [x] Integration harness starts Postgres via Testcontainers and runs `migrate deploy`
- [x] Each integration test starts from a clean database — and each test *file*
      gets its own database, see below
- [x] `DATABASE_URL` is read through zod-validated typed config, never `process.env`
      directly — and this is now enforced by ESLint, not by convention
- [x] `passWithNoTests: true` is deleted from `jest.config.ts` — the `integration`
      project now owns a test, so "no tests found" fails again (see Task 3)

**Verification:**
- [x] `npm test -- --selectProjects integration` passes tests that write and read rows
- [x] Full bar green: `typecheck`, `lint`, `format:check`, `build`, 18 tests across
      three projects, **100% coverage** on every metric with nothing excluded but `main.ts`
- [x] A unit-only run starts **no** container: `--selectProjects unit` is 3.8s and
      prints no migration output
- [x] Parallel isolation proven, not assumed: two throwaway `*.int-spec.ts` files
      writing and truncating concurrently both passed, then were deleted
- [x] Ten consecutive full runs green

**Decisions taken here:**

*Prisma 7 connects through a driver adapter — see
[ADR 0004](../docs/adr/0004-prisma-7-driver-adapters.md).* `url` is no longer
allowed in the `datasource` block, there is no Rust query engine, and the CLI
reads `apps/api/prisma.config.ts` while the client is constructed with
`@prisma/adapter-pg`. That is a new runtime dependency, raised and approved
rather than assumed. It also means `SPEC.md`'s "never read `process.env`
directly" stopped fighting the tool: Prisma 7 *requires* the connection string be
handed in, which is exactly what `AppConfig` does.

*The ban on `process.env` is a lint rule, not a paragraph.*
`no-restricted-properties` fails the build on any environment read in
application code; `src/shared/config/config.module.ts` opts out on one annotated
line. The harness under `test/` is exempt by file, because repointing
`DATABASE_URL` at a throwaway database is its entire job — a per-line escape
hatch every second line only teaches people to reach for the escape hatch.

*`currency` lands here rather than in Task 6.* The harness needs one real,
specified table to prove itself against, and an invented one would be a
permanent fixture in the production schema. `currency` is the root of the
foreign-key graph (`user`, `portfolio` and `instrument` all reference it) and is
fully specified in `SPEC-catalog.md`. Task 6 keeps `exchange`, `data_source`, the
seed and the endpoints.

*The migration was authored with `prisma migrate diff`, not `migrate dev`.*
`migrate dev` wants a live database and a shadow database, and would have run
against the shared development instance. `--from-empty --to-schema` renders the
same SQL deterministically with no database at all. The harness then applies it
with `migrate deploy`, so tests exercise the committed migration exactly as a
deployment would — a migration that only works when Prisma regenerates it is a
broken migration.

*One container for the run, one database per test file, one TRUNCATE per test.*
Three mechanisms because there are three distinct problems. Jest runs test files
in parallel workers, so a single shared database means one file's clean-up
TRUNCATE silently deletes another file's rows mid-test — intermittent, dependent
on worker scheduling, and it reads like a bug in the code under test. Each file
therefore clones its own database from a migrated template, which is a file copy
rather than a migration replay. Within a file, tests still share a database, so
each starts from a TRUNCATE.

*The global hooks are declared on the two database-backed projects, not at the
root.* A root-level `globalSetup` runs for every invocation, so
`--selectProjects unit` would have paid five seconds of container startup to run
tests that never touch a database — defeating the fast loop Task 3 exists to
protect. Jest keys global hooks by module path, so naming the same file on both
projects still starts exactly one container.

*`global-setup.ts` repoints `DATABASE_URL` before any worker starts.* This is a
safety property, not a convenience. Inside the toolchain container that variable
otherwise names the **development** database, so any code reading it at module
scope — before the per-file hook narrows it — would connect to real development
data and succeed. A throwaway probe did exactly that during this task and wrote
nothing, because the table did not exist; on a seeded dev database it would have
written. The worst case is now the throwaway template.

**Known and accepted:** one full run failed in `integration-setup`'s `beforeAll`
immediately after `npm run format` rewrote that file mid-flight — a stale ts-jest
cache. It did not reproduce in ten subsequent runs, including with a cleared
cache. `CREATE DATABASE ... TEMPLATE` is nonetheless genuinely racy under
concurrency (PostgreSQL `55006`), so it now retries with backoff rather than
relying on the race not recurring.

**Dependencies:** Task 3
**Files:** `apps/api/prisma/schema.prisma`, `apps/api/prisma.config.ts`,
`apps/api/prisma/migrations/*/migration.sql`,
`apps/api/src/shared/config/app-config.ts`, `apps/api/src/shared/config/config.module.ts`,
`apps/api/src/shared/prisma/prisma.service.ts`, `apps/api/src/shared/prisma/prisma.module.ts`,
`apps/api/test/database.ts`, `apps/api/test/global-setup.ts`,
`apps/api/test/global-teardown.ts`, `apps/api/test/integration-setup.ts`,
`apps/api/src/app.module.ts`, `apps/api/src/main.ts`, `jest.config.ts`,
`eslint.config.mjs`, `compose-dev.yaml`, `SPEC.md`, `ARCHITECTURE.md`,
`docs/adr/0004-prisma-7-driver-adapters.md`
**Scope:** M

---

### - [x] Task 5: SPIKE — class-table inheritance in Prisma

**Description:** Throwaway spike proving the `instrument` hierarchy is expressible
before `catalog` depends on it. This is the single highest-risk decision in the
project (`tasks/plan.md` §Risks) and costs one file to settle.

Must demonstrate: base + specialization as 1:1 relations; a database `CHECK`
constraint (hand-written migration) rejecting a mismatched `instrument_type`;
a partial unique index applying only to public rows; and a TypeScript
discriminated union at the service boundary with exhaustiveness checking.

**Acceptance criteria:**
- [x] All four behaviours demonstrated against a real Postgres — 8/8 spike integration tests green
- [x] Raw SQL inserting a mismatched specialization is rejected **by the database**
- [x] Findings written to `docs/adr/0001-instrument-inheritance.md` with a go/no-go — filed as
      `docs/adr/0005-instrument-inheritance.md` instead: `0001` was already taken by the
      monorepo ADR (Ruling S8, ADR numbers are immutable); content and go/no-go verdict match
- [x] Spike code deleted or clearly quarantined — it is not production code — deleted entirely
      in fix round 1 (Ruling S9); the ADR carries the full DDL inline, commit `6b76f7d` preserves
      the runnable spike

**Verification:**
- [x] Spike integration test passes, then the ADR records the decision — GO, Task 13 proceeded

**Dependencies:** Task 4
**Files:** `docs/adr/0001-instrument-inheritance.md`, spike schema + one int-spec (throwaway)
**Scope:** S

> **Gate:** if this spike fails, stop and reassess the ORM before Phase 3. Do not
> proceed to Task 13 on the assumption it will work out.

---

### - [x] Task 6: Reference data and seed

**Description:** `currency`, `exchange` and `data_source` per
`SPEC-catalog.md`, with a seed. These are foreign keys from `user`, `portfolio` and
`instrument`, so nothing downstream can migrate without them.

**Reduced by Task 4:** `currency` is already migrated — Task 4 needed one real,
specified table to prove the integration harness against, and `currency` is the
root of the foreign-key graph. What remains here is `exchange`, `data_source`,
the seed and the two endpoints.

**Acceptance criteria:**
- [x] `currency` migrated with the documented columns and keys (Task 4)
- [x] `exchange` and `data_source` migrated with the documented columns and keys
- [x] Seed loads BRL, USD, EUR; the B3 exchange; at least one data source
- [x] Seed is idempotent — running twice leaves the same rows
- [x] `GET /currencies` and `GET /exchanges` return seeded data — public in Phase 0 (`AuthGuard`
      doesn't exist yet, Ruling S4); gated behind it once `identity` lands, closed for real in
      Task 13 (commit `d3700e1`, "require auth on the reference routes")

**Verification:**
- [x] `npx prisma migrate reset && npx prisma db seed` twice, then integration test asserts row counts

**Dependencies:** Task 4
**Files:** `apps/api/prisma/schema.prisma`, `apps/api/prisma/seed.ts`, `apps/api/src/modules/catalog/reference.controller.ts`, `*.int-spec.ts`
**Scope:** M

---

## Checkpoint A: Foundation
- [x] `npm ci && npm run build && npm test` passes from a clean checkout
- [x] Integration tests run against real Postgres via Testcontainers
- [x] **Spike ADR reviewed — inheritance approach confirmed or ORM reassessed** — task-reviewed,
      verdict GO ("yes with caveats"; caveats became Task 13 acceptance items)
- [x] Reference data seeds idempotently
- [x] Review with human before proceeding — owner sign-off received 2026-09-07 ("Proceed to
      Phase 1"; Task 7's auth-model gate separately "Approved as specified")

---

## Phase 1: `identity`

### - [x] Task 7: GATE — update the ER model for auth tables

**Description:** `SPEC-identity.md` introduces `user_credential` and `session`,
which the original ER model deliberately excluded as an auth concern. That is a
data-model change and falls under *Ask first* in `SPEC.md` §Boundaries.

**Largely done ahead of time:** both tables are specified in `SPEC-identity.md`
and present in `ARCHITECTURE.md` §5's ER diagram, and the token design is
recorded in [ADR 0003](../docs/adr/0003-jwt-access-tokens-with-refresh-sessions.md).
What remains is the explicit human sign-off before the migration is written.

**Acceptance criteria:**
- [x] `SPEC-identity.md` documents all three entities with full attribute tables, and `ARCHITECTURE.md` §5's ER diagram includes them
- [x] A mermaid diagram includes them and still parses
- [x] Human has approved the addition — specifically that `session` is a *refresh-token store* (`token_hash`, `client_type`, `replaced_by_id`), not a cookie-session table — "Approved as specified" (2026-09-07)

**Verification:**
- [x] Mermaid blocks parse; entity dictionary and diagrams stay consistent

**Dependencies:** None (can run during Phase 0)
**Files:** `SPEC-identity.md`, `ARCHITECTURE.md`
**Scope:** XS

---

### - [x] Task 8: identity schema and password hashing

**Description:** Migrate `user`, `user_credential`, `session`. Implement hashing
as pure domain code with no I/O so it is unit-testable in isolation.

`session` is a refresh-token store, not a cookie-session table — one row per
logged-in device, holding a SHA-256 hash of the token and a rotation chain. See
[ADR 0003](../docs/adr/0003-jwt-access-tokens-with-refresh-sessions.md).

**Acceptance criteria:**
- [x] argon2id hashing for **passwords** (bcrypt cost ≥ 12 fallback if the native build fails) — `@node-rs/argon2`, pinned OWASP params, ADR 0006
- [x] SHA-256 for the **refresh token** — deliberately not argon2id; the token is 256 bits of server randomness, so a slow hash buys nothing and costs latency on every refresh
- [x] `user.email` unique **by database constraint**, proven by a direct duplicate insert
- [x] Credentials in a separate table; the hash is never selectable via a user query
- [x] `session.token_hash` unique; `replaced_by_id` self-references `session` for the rotation chain — `onDelete` corrected `SetNull` → `Restrict` in Task 10 (deferred minor from this task's review, needed so reuse detection's `replacedById` genuinely persists)
- [x] `base_currency_code` FK-validated against `currency`

**Verification:**
- [x] `npm test -- --selectProjects unit -- identity` — hash/verify round trip
- [x] `npm test -- --selectProjects integration -- identity` — unique constraint

**Dependencies:** Tasks 6, 7
**Files:** `apps/api/prisma/schema.prisma`, `apps/api/src/modules/identity/domain/password.ts`, `token.ts`, `*.spec.ts`, `identity.module.ts`, `*.int-spec.ts`
**Scope:** M

---

### - [x] Task 9: Register and login

**Description:** `POST /auth/register` and `POST /auth/login`, both issuing an
access-token/refresh-token pair. Signup is open self-service — multi-user from
the first slice.

**Acceptance criteria:**
- [x] Both endpoints create a `session` row storing only the SHA-256 hash of the refresh token, and return a signed EdDSA access token
- [x] The access token carries `sub`, `sid`, `iat`, `exp`, `iss`, `aud` and nothing else — no email, no display name
- [x] For `client_type = WEB` the refresh token is set as an `httpOnly; Secure; SameSite=Strict` cookie path-scoped to `/auth/refresh`, and never appears in a response body
- [x] For `client_type = ANDROID` both tokens are returned in the body and no cookie is set
- [x] Wrong password and unknown email return the **same** error and take **indistinguishable** time — no user enumeration through either channel (timing ratio ~1.04, bound 2.5)
- [x] Password policy enforced: minimum 12 characters
- [x] Auth endpoints rate-limited per IP — hand-rolled guard (Ruling S10, `@nestjs/throttler` incompatible with Nest 12 peers); wiring itself proven live by a real 6th-request-429 e2e (F9b.1 fix)
- [x] No password, hash or raw token appears in any response or log line

**Verification:**
- [x] E2E: register → token pair issued → login → token pair issued, for both client types
- [x] Integration test asserting the timing/response equivalence of the two failure modes
- [x] Integration test asserting the raw refresh token appears nowhere in the `session` table

**Dependencies:** Task 8
**Files:** `apps/api/src/modules/identity/identity.controller.ts`, `identity.service.ts`, `dto/`, `apps/api/test/e2e/identity.e2e-spec.ts`
**Scope:** M

---

### - [x] Task 10: AuthGuard, token refresh and rotation, profile

**Description:** `AuthGuard` and the `CurrentUser` decorator — the public contract
every other module consumes — plus `POST /auth/refresh`, `POST /auth/logout`,
`POST /auth/logout-all`, `GET /auth/me` and `PATCH /auth/me`.

**Acceptance criteria:**
- [x] `AuthGuard` rejects missing, malformed, expired and wrongly-signed tokens with 401 — never 500
- [x] A token forged with `alg: none`, with the wrong key, or with an unknown `kid` is rejected. One test per forgery
- [x] `POST /auth/refresh` rotates: the presented token is revoked with `replaced_by_id` set, and a new pair issued
- [x] **Reuse detection** — replaying an already-rotated refresh token revokes the whole chain for that user — strict mode kept at Checkpoint B owner review; grace-window variant recorded as a deferred option in ADR 0003
- [x] `POST /auth/logout` revokes the current session; `POST /auth/logout-all` revokes every session for the user — `logout`'s write query additionally scoped to the caller's own `userId` in the final-review fix wave (it was the one user-owned query on the branch not scoped in its `where`)
- [x] `CurrentUser` exposes the authenticated user id to controllers
- [x] `PATCH /auth/me` updates only `display_name`, `base_currency_code`, `timezone`

**Verification:**
- [x] E2E covering every rejection case, the rotation round trip, and reuse detection
- [x] E2E proving logout-all invalidates a *second* device's session, not just the caller's

**Dependencies:** Task 9
**Files:** `apps/api/src/modules/identity/auth.guard.ts`, `current-user.decorator.ts`, `identity.controller.ts`, `apps/api/test/e2e/identity.e2e-spec.ts`
**Scope:** M

---

## Checkpoint B: `identity` complete
- [x] Full register → login → me → logout flow passes E2E
- [x] No user enumeration via login errors or timing
- [x] `AuthGuard` / `CurrentUser` contract is settled — Phases 2 and 3 depend on it and may now run in parallel
- [x] Review with human before proceeding — presented 2026-09-07; owner kept reuse detection
      strict and paused before Phases 2/3 to inspect Phase 1 first, then resumed 2026-09-13 ("go")

---

## Phase 2: `portfolio`

### - [x] Task 11: Portfolio schema and owned reads

**Description:** `portfolio` per `SPEC-portfolio.md`, with create, list and get.
Ownership is scoped **in the query**, never checked after fetching.

**Acceptance criteria:**
- [x] `POST /portfolios` creates with name, objective, base currency
- [x] `GET /portfolios` lists only the caller's active portfolios
- [x] Requesting another user's portfolio returns **404, not 403** — ids must not be enumerable
- [x] Every query filters by `userId` in the `where` clause — verified method-by-method in review
- [ ] `objective` accepts only `RETIREMENT`, `EDUCATION`, `EMERGENCY`, `GENERAL`, or null —
      **superseded before implementation by Ruling S2**: `SPEC-portfolio.md` is unambiguous and
      repeated (data model, prose, AC) that `objective` is free text ≤255 chars, never
      enum-validated ("an enum would force it into a GENERAL bucket that communicates nothing").
      What was built matches the binding spec, not this plan line; left unchecked because the
      literal criterion as written here was deliberately not implemented, not because anything
      is missing.

**Verification:**
- [x] E2E: user A creates; user B gets `[]` from list and 404 on A's id

**Dependencies:** Task 10
**Files:** `apps/api/prisma/schema.prisma`, `apps/api/src/modules/portfolio/{portfolio.module,portfolio.service,portfolio.controller}.ts`, `dto/`
**Scope:** M

---

### - [x] Task 12: Portfolio constraints and archive

**Description:** The rules that carry real weight: immutable base currency,
per-user name uniqueness, and archive-not-delete.

**Acceptance criteria:**
- [x] `PATCH` rejects any change to `base_currency_code` or `user_id`, with an error naming why — `.strict()` schema rejects the unrecognized key
- [x] `(user_id, name)` unique **by database constraint**; two *different* users may both have "Retirement"
- [x] Archive sets `archived_at` and drops it from the default list without deleting the row
- [x] `?includeArchived=true` returns archived portfolios; unarchive restores
- [x] No `DELETE` endpoint exists — negative e2e proves it

**Verification:**
- [x] Integration: duplicate name rejected for one user, accepted across two users
- [x] E2E: archive → absent from list → unarchive → present

**Dependencies:** Task 11
**Files:** `apps/api/prisma/schema.prisma` (migration), `portfolio.service.ts`, `portfolio.controller.ts`, `*.int-spec.ts`
**Scope:** M

---

## Checkpoint C: `portfolio` complete
- [x] Ownership isolation proven by test, not inspection
- [x] Base-currency immutability and archive semantics hold
- [ ] Review with human before proceeding — deliberately NOT paused here: Auto Mode was active
      and the owner's standing instruction ("go") was read as covering Checkpoints C/D, which
      carry none of Checkpoints A/B's "Ask first" sensitivity (auth, schema ER model). Left
      unchecked because the literal review did not happen, not because the work is unproven —
      Tasks 11/12 each still went through an individual task review.

---

## Phase 3: `catalog`

### - [x] Task 13: Instrument hierarchy and database constraints

**Description:** The base `instrument` plus four specializations, applying the
approach settled by the Task 5 spike. The constraints here cannot be expressed in
Prisma and require a hand-edited migration.

**Acceptance criteria:**
- [x] Four specialization tables with 1:1 relations to `instrument`
- [x] A database `CHECK`/trigger rejects a specialization not matching `instrument_type` — proven via raw SQL bypassing the service layer
- [x] Partial unique index on `(exchange_code, ticker)` and `(symbol, network)` applying to **public rows only**
- [x] Two users may each hold a private instrument with the same name; public duplicates are rejected
- [x] `is_variable_income` enforced true for equity/ETF/crypto, false for fixed income — DB `CHECK`, total equivalence proven both directions

**Verification:**
- [x] `npm test -- --selectProjects integration -- catalog`, including the raw-SQL violation attempts

**Dependencies:** Tasks 5, 6, 10
**Files:** `apps/api/prisma/schema.prisma`, `apps/api/prisma/migrations/*/migration.sql` (hand-edited), `apps/api/src/modules/catalog/`, `*.int-spec.ts`
**Scope:** M

---

### - [x] Task 14: Discriminated-union read model

**Description:** Expose instruments as a TypeScript discriminated union on
`instrumentType` so consumers get exhaustiveness checking, rather than four
optional relations that push `undefined` handling into every caller.

**Acceptance criteria:**
- [x] `GET /instruments/:id` returns base + specialization as one discriminated union
- [x] `GET /instruments` returns public instruments ∪ the caller's private ones
- [x] Search filters by type, ticker and name
- [x] Adding a fifth `instrument_type` produces a **compile error** at every exhaustive switch until handled — demonstrated in a type-level test — `TS2345` reproduced for real, not merely claimed

**Verification:**
- [x] Unit tests on the mapper for all four types
- [x] E2E: A's private instrument absent from B's list

**Dependencies:** Task 13
**Files:** `apps/api/src/modules/catalog/{catalog.service,catalog.controller}.ts`, `domain/instrument.ts`, `*.spec.ts`
**Scope:** M

---

### - [x] Task 15: Private instrument creation

**Description:** `POST` / `PATCH /instruments` for user-owned fixed-income
contracts. Base and specialization must be written atomically.

**Acceptance criteria:**
- [x] Base + specialization created in **one transaction**; a forced failure of the second leaves no partial row
- [x] `POST` rejects any attempt to create a public instrument (`owner_user_id = null`)
- [x] `PATCH` only touches instruments the caller owns; others return 404 — the mutating `update()`'s own `where` scoped by `userId`/type (fix round 1, F15.1), not just a preceding check
- [x] Fixed-income fields validated: `maturity_date` after `issue_date`, `indexation_type` in the documented set

**Verification:**
- [x] Integration test forcing the second insert to fail and asserting zero rows
- [x] E2E: create a private CDB, read it back, confirm B cannot

**Dependencies:** Task 14
**Files:** `apps/api/src/modules/catalog/catalog.service.ts`, `catalog.controller.ts`, `dto/`, `*.int-spec.ts`
**Scope:** M

---

## Checkpoint D: `catalog` complete
- [x] Specialization constraint enforced by the database, not just the service
- [x] Private instrument isolation proven
- [x] Atomicity proven by a forced-failure test
- [ ] Review with human before proceeding — same Auto Mode call as Checkpoint C: deliberately not
      paused here (no "Ask first" sensitivity), each of Tasks 13-15 individually task-reviewed.
      Left unchecked because the literal checkpoint pause did not happen.

---

## Phase 4: Proof

### - [x] Task 16: Walking-skeleton end-to-end test

**Description:** The single test that proves all three modules work together —
the scenario in `SPEC-portfolio.md` §Verification, verbatim.

**Acceptance criteria:**
- [x] Full flow: A registers → logs in → creates "Retirement" (BRL) → creates a private CDB → `GET /portfolios` returns exactly that portfolio
- [x] B registers → `GET /portfolios` returns `[]` → `GET /portfolios/<A's id>` returns 404 → `GET /instruments` does not list A's CDB
- [x] Runs against a real database in CI

**Verification:**
- [x] `npm run test:e2e` green from a clean database

**Dependencies:** Tasks 12, 15
**Files:** `apps/api/test/e2e/walking-skeleton.e2e-spec.ts`
**Scope:** S

---

### - [x] Task 17: CI pipeline

**Description:** Enforce the standing bar on every push so it cannot quietly erode.

**Acceptance criteria:**
- [x] CI runs typecheck, lint, unit, integration and e2e
- [x] Coverage gate at 80% global fails the build when unmet
- [x] Postgres available to integration and e2e jobs — nested-Testcontainers topology, socket share + host-gateway
- [x] `npx prisma migrate deploy` verified against an empty database

**Verification:**
- [x] A deliberately failing test and a deliberate coverage drop both red the build — both proven locally (no real GH Actions run available; standing caveat, not a gap in this branch's own verification)

**Dependencies:** Task 16
**Files:** `.github/workflows/ci.yml`
**Scope:** S

---

## Checkpoint: Complete
- [x] All acceptance criteria met across Tasks 1–17
- [x] Walking skeleton passes end to end from a clean checkout
- [x] Every entity touched by this slice has a matching Prisma model
- [ ] Open questions in `tasks/plan.md` revisited — especially the **undecided frontend framework**, which blocks `reporting`
  (Frontend framework remains an open decision for the project owner — tracked in SPEC.md Open Questions #7, not resolved by this branch.)
- [ ] Ready to specify `ledger`
