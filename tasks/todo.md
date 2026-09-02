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
`Dockerfile`, wired up by `compose.yaml` alongside a Postgres service. Docker
and Compose are now the only host requirements.

**Acceptance criteria:**
- [x] Docker daemon reachable and Compose v2+ present — 29.7.2 and v5.4.0
- [x] The toolchain image reports Node ≥ 20 — reports 24.20.0, matching `.nvmrc`
- [x] `libssl` present in the image — `node:*-slim` omits it and Prisma's query engine links it
- [x] The container reaches the docker socket and `host.docker.internal`, so Testcontainers works
- [x] A Postgres service comes up healthy and is reachable from the app container
- [x] Files written into the bind mount are owned by the developer, not by root
- [x] `.nvmrc` retained, now documenting optional host-native work only

**Verification:**
- [x] `./scripts/check-env.sh` exits 0
- [x] `./scripts/check-env.sh --full` exits 0 — builds the image and checks node, libssl and the socket
- [x] Testcontainers started a sibling Postgres 17.11 from inside the app container and ran a query
- [x] `./scripts/dev.sh node --version` → `v24.20.0`; a TCP probe reached `db:5432`

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

*Dev-database credentials are committed in `compose.yaml` on purpose.* They are
identical for every developer and reachable only from the local Compose network.
Nothing deployed reads them; deployed credentials come from the environment.
This is not a breach of `SPEC.md` §Boundaries "never commit secrets".

**Superseded:** the original task required Node ≥ 20 *on the host* and listed
`nvm` install steps. Nothing runs on the host now, so `check-env.sh` reports the
host Node version as information rather than failing on it. `.nvmrc` is kept for
anyone who chooses to work host-natively.

**Dependencies:** None
**Files:** `Dockerfile`, `compose.yaml`, `.dockerignore`, `.env.example`,
`.nvmrc`, `.gitignore`, `scripts/check-env.sh`, `scripts/dev.sh`,
`scripts/_docker.sh`
**Scope:** S

---

### - [ ] Task 2: NestJS scaffold with pinned versions

**Description:** Create the NestJS application on the Fastify adapter with the
exact versions from `SPEC.md` §Tech Stack. The pins are not preferences — `@latest`
resolves to a Prisma RC and to a TypeScript that `ts-jest` rejects.

**Acceptance criteria:**
- [ ] `prisma` and `@prisma/client` both pinned to exactly `7.10.0` (not `^`, not `latest`)
- [ ] `typescript` pinned to `6.0.3`; TS 7.x must not appear in the lockfile
- [ ] `tsconfig.json` has `strict: true`, `emitDecoratorMetadata`, `experimentalDecorators`
- [ ] App boots on Fastify and answers `GET /health` with 200

**Verification:**
- [ ] `npm run build && npm run start:prod` then `curl localhost:3000/health`
- [ ] `npm ls typescript prisma @prisma/client` shows the pinned versions

**Dependencies:** Task 1
**Files:** `package.json`, `tsconfig.json`, `src/main.ts`, `src/app.module.ts`
**Scope:** M

---

### - [ ] Task 3: Quality gates

**Description:** ESLint, Prettier, and Jest configured as three selectable
projects (unit / integration / e2e) so the fast suite stays fast.

**Acceptance criteria:**
- [ ] `npm test -- --selectProjects unit` runs only `src/**/*.spec.ts`
- [ ] Integration and e2e projects are declared and select their own patterns
- [ ] Coverage thresholds enforced: 80% global
- [ ] Lint fails on `any` and on floating promises

**Verification:**
- [ ] `npm run lint && npm run typecheck && npm test` all pass with one smoke test

**Dependencies:** Task 2
**Files:** `eslint.config.mjs`, `.prettierrc`, `jest.config.ts`, `src/app.spec.ts`
**Scope:** M

---

### - [ ] Task 4: Prisma + Testcontainers harness

**Description:** Wire Prisma to PostgreSQL, add `PrismaService` with lifecycle
hooks, and build the integration-test harness that starts a real Postgres,
applies migrations, and truncates between tests.

**Acceptance criteria:**
- [ ] `PrismaService` connects on module init and disconnects on shutdown
- [ ] Integration harness starts Postgres via Testcontainers and runs `migrate deploy`
- [ ] Each integration test starts from a clean database
- [ ] `DATABASE_URL` is read through zod-validated typed config, never `process.env` directly

**Verification:**
- [ ] `npm test -- --selectProjects integration` passes a test that writes and reads a row

**Dependencies:** Task 3
**Files:** `prisma/schema.prisma`, `src/shared/prisma/prisma.service.ts`, `src/shared/config/`, `test/integration-setup.ts`
**Scope:** M

---

### - [ ] Task 5: SPIKE — class-table inheritance in Prisma

**Description:** Throwaway spike proving the `instrument` hierarchy is expressible
before `catalog` depends on it. This is the single highest-risk decision in the
project (`tasks/plan.md` §Risks) and costs one file to settle.

Must demonstrate: base + specialization as 1:1 relations; a database `CHECK`
constraint (hand-written migration) rejecting a mismatched `instrument_type`;
a partial unique index applying only to public rows; and a TypeScript
discriminated union at the service boundary with exhaustiveness checking.

**Acceptance criteria:**
- [ ] All four behaviours demonstrated against a real Postgres
- [ ] Raw SQL inserting a mismatched specialization is rejected **by the database**
- [ ] Findings written to `docs/adr/0001-instrument-inheritance.md` with a go/no-go
- [ ] Spike code deleted or clearly quarantined — it is not production code

**Verification:**
- [ ] Spike integration test passes, then the ADR records the decision

**Dependencies:** Task 4
**Files:** `docs/adr/0001-instrument-inheritance.md`, spike schema + one int-spec (throwaway)
**Scope:** S

> **Gate:** if this spike fails, stop and reassess the ORM before Phase 3. Do not
> proceed to Task 13 on the assumption it will work out.

---

### - [ ] Task 6: Reference data and seed

**Description:** `currency`, `exchange` and `data_source` per `ARCHITECTURE.md`
§7.1–§7.3, with a seed. These are foreign keys from `user`, `portfolio` and
`instrument`, so nothing downstream can migrate without them.

**Acceptance criteria:**
- [ ] Three tables migrated with the documented columns and keys
- [ ] Seed loads BRL, USD, EUR; the B3 exchange; at least one data source
- [ ] Seed is idempotent — running twice leaves the same rows
- [ ] `GET /currencies` and `GET /exchanges` return seeded data

**Verification:**
- [ ] `npx prisma migrate reset && npx prisma db seed` twice, then integration test asserts row counts

**Dependencies:** Task 4
**Files:** `prisma/schema.prisma`, `prisma/seed.ts`, `src/modules/catalog/reference.controller.ts`, `*.int-spec.ts`
**Scope:** M

---

## Checkpoint A: Foundation
- [ ] `npm ci && npm run build && npm test` passes from a clean checkout
- [ ] Integration tests run against real Postgres via Testcontainers
- [ ] **Spike ADR reviewed — inheritance approach confirmed or ORM reassessed**
- [ ] Reference data seeds idempotently
- [ ] Review with human before proceeding

---

## Phase 1: `identity`

### - [ ] Task 7: GATE — update the ER model for auth tables

**Description:** `SPEC-identity.md` introduces `user_credential` and `session`,
which `ARCHITECTURE.md` deliberately excluded as an auth concern. That is a
data-model change and falls under *Ask first* in `SPEC.md` §Boundaries. Update
the model and get approval **before** writing the migration.

**Acceptance criteria:**
- [ ] `ARCHITECTURE.md` §7 documents both new entities with full attribute tables
- [ ] A mermaid diagram includes them and still parses
- [ ] Human has approved the addition

**Verification:**
- [ ] Mermaid blocks parse; entity dictionary and diagrams stay consistent

**Dependencies:** None (can run during Phase 0)
**Files:** `ARCHITECTURE.md`
**Scope:** XS

---

### - [ ] Task 8: identity schema and password hashing

**Description:** Migrate `user`, `user_credential`, `session`. Implement hashing
as pure domain code with no I/O so it is unit-testable in isolation.

**Acceptance criteria:**
- [ ] argon2id hashing (bcrypt cost ≥ 12 fallback if the native build fails)
- [ ] `user.email` unique **by database constraint**, proven by a direct duplicate insert
- [ ] Credentials in a separate table; the hash is never selectable via a user query
- [ ] `base_currency_code` FK-validated against `currency`

**Verification:**
- [ ] `npm test -- --selectProjects unit -- identity` — hash/verify round trip
- [ ] `npm test -- --selectProjects integration -- identity` — unique constraint

**Dependencies:** Tasks 6, 7
**Files:** `prisma/schema.prisma`, `src/modules/identity/domain/password.ts`, `password.spec.ts`, `identity.module.ts`, `*.int-spec.ts`
**Scope:** M

---

### - [ ] Task 9: Register and login

**Description:** `POST /auth/register` and `POST /auth/login`, both issuing a
server-side session in an httpOnly cookie.

**Acceptance criteria:**
- [ ] Both endpoints create a session row and set `httpOnly; Secure; SameSite=Lax`
- [ ] Wrong password and unknown email return the **same** error and take **indistinguishable** time — no user enumeration through either channel
- [ ] Password policy enforced: minimum 12 characters
- [ ] Auth endpoints rate-limited per IP
- [ ] No password or hash appears in any response or log line

**Verification:**
- [ ] E2E: register → cookie set → login → cookie set
- [ ] Integration test asserting the timing/response equivalence of the two failure modes

**Dependencies:** Task 8
**Files:** `src/modules/identity/identity.controller.ts`, `identity.service.ts`, `dto/`, `test/e2e/identity.e2e-spec.ts`
**Scope:** M

---

### - [ ] Task 10: AuthGuard, session lifecycle, profile

**Description:** `AuthGuard` and the `CurrentUser` decorator — the public contract
every other module consumes — plus `GET /auth/me`, `PATCH /auth/me`, `POST /auth/logout`.

**Acceptance criteria:**
- [ ] `AuthGuard` rejects missing, unknown, expired and revoked sessions with 401 — never 500
- [ ] `POST /auth/logout` revokes such that reusing the cookie returns 401
- [ ] `CurrentUser` exposes the authenticated user id to controllers
- [ ] `PATCH /auth/me` updates only `display_name`, `base_currency_code`, `timezone`

**Verification:**
- [ ] E2E covering all four rejection cases and the logout round trip

**Dependencies:** Task 9
**Files:** `src/modules/identity/auth.guard.ts`, `current-user.decorator.ts`, `identity.controller.ts`, `test/e2e/identity.e2e-spec.ts`
**Scope:** M

---

## Checkpoint B: `identity` complete
- [ ] Full register → login → me → logout flow passes E2E
- [ ] No user enumeration via login errors or timing
- [ ] `AuthGuard` / `CurrentUser` contract is settled — Phases 2 and 3 depend on it and may now run in parallel
- [ ] Review with human before proceeding

---

## Phase 2: `portfolio`

### - [ ] Task 11: Portfolio schema and owned reads

**Description:** `portfolio` per `ARCHITECTURE.md` §7.5, with create, list and get.
Ownership is scoped **in the query**, never checked after fetching.

**Acceptance criteria:**
- [ ] `POST /portfolios` creates with name, objective, base currency
- [ ] `GET /portfolios` lists only the caller's active portfolios
- [ ] Requesting another user's portfolio returns **404, not 403** — ids must not be enumerable
- [ ] Every query filters by `userId` in the `where` clause
- [ ] `objective` accepts only `RETIREMENT`, `EDUCATION`, `EMERGENCY`, `GENERAL`, or null

**Verification:**
- [ ] E2E: user A creates; user B gets `[]` from list and 404 on A's id

**Dependencies:** Task 10
**Files:** `prisma/schema.prisma`, `src/modules/portfolio/{portfolio.module,portfolio.service,portfolio.controller}.ts`, `dto/`
**Scope:** M

---

### - [ ] Task 12: Portfolio constraints and archive

**Description:** The rules that carry real weight: immutable base currency,
per-user name uniqueness, and archive-not-delete.

**Acceptance criteria:**
- [ ] `PATCH` rejects any change to `base_currency_code` or `user_id`, with an error naming why
- [ ] `(user_id, name)` unique **by database constraint**; two *different* users may both have "Retirement"
- [ ] Archive sets `archived_at` and drops it from the default list without deleting the row
- [ ] `?includeArchived=true` returns archived portfolios; unarchive restores
- [ ] No `DELETE` endpoint exists

**Verification:**
- [ ] Integration: duplicate name rejected for one user, accepted across two users
- [ ] E2E: archive → absent from list → unarchive → present

**Dependencies:** Task 11
**Files:** `prisma/schema.prisma` (migration), `portfolio.service.ts`, `portfolio.controller.ts`, `*.int-spec.ts`
**Scope:** M

---

## Checkpoint C: `portfolio` complete
- [ ] Ownership isolation proven by test, not inspection
- [ ] Base-currency immutability and archive semantics hold
- [ ] Review with human before proceeding

---

## Phase 3: `catalog`

### - [ ] Task 13: Instrument hierarchy and database constraints

**Description:** The base `instrument` plus four specializations, applying the
approach settled by the Task 5 spike. The constraints here cannot be expressed in
Prisma and require a hand-edited migration.

**Acceptance criteria:**
- [ ] Four specialization tables with 1:1 relations to `instrument`
- [ ] A database `CHECK`/trigger rejects a specialization not matching `instrument_type` — proven via raw SQL bypassing the service layer
- [ ] Partial unique index on `(exchange_code, ticker)` and `(symbol, network)` applying to **public rows only**
- [ ] Two users may each hold a private instrument with the same name; public duplicates are rejected
- [ ] `is_variable_income` enforced true for equity/ETF/crypto, false for fixed income

**Verification:**
- [ ] `npm test -- --selectProjects integration -- catalog`, including the raw-SQL violation attempts

**Dependencies:** Tasks 5, 6, 10
**Files:** `prisma/schema.prisma`, `prisma/migrations/*/migration.sql` (hand-edited), `src/modules/catalog/`, `*.int-spec.ts`
**Scope:** M

---

### - [ ] Task 14: Discriminated-union read model

**Description:** Expose instruments as a TypeScript discriminated union on
`instrumentType` so consumers get exhaustiveness checking, rather than four
optional relations that push `undefined` handling into every caller.

**Acceptance criteria:**
- [ ] `GET /instruments/:id` returns base + specialization as one discriminated union
- [ ] `GET /instruments` returns public instruments ∪ the caller's private ones
- [ ] Search filters by type, ticker and name
- [ ] Adding a fifth `instrument_type` produces a **compile error** at every exhaustive switch until handled — demonstrated in a type-level test

**Verification:**
- [ ] Unit tests on the mapper for all four types
- [ ] E2E: A's private instrument absent from B's list

**Dependencies:** Task 13
**Files:** `src/modules/catalog/{catalog.service,catalog.controller}.ts`, `domain/instrument.ts`, `*.spec.ts`
**Scope:** M

---

### - [ ] Task 15: Private instrument creation

**Description:** `POST` / `PATCH /instruments` for user-owned fixed-income
contracts. Base and specialization must be written atomically.

**Acceptance criteria:**
- [ ] Base + specialization created in **one transaction**; a forced failure of the second leaves no partial row
- [ ] `POST` rejects any attempt to create a public instrument (`owner_user_id = null`)
- [ ] `PATCH` only touches instruments the caller owns; others return 404
- [ ] Fixed-income fields validated: `maturity_date` after `issue_date`, `indexation_type` in the documented set

**Verification:**
- [ ] Integration test forcing the second insert to fail and asserting zero rows
- [ ] E2E: create a private CDB, read it back, confirm B cannot

**Dependencies:** Task 14
**Files:** `src/modules/catalog/catalog.service.ts`, `catalog.controller.ts`, `dto/`, `*.int-spec.ts`
**Scope:** M

---

## Checkpoint D: `catalog` complete
- [ ] Specialization constraint enforced by the database, not just the service
- [ ] Private instrument isolation proven
- [ ] Atomicity proven by a forced-failure test
- [ ] Review with human before proceeding

---

## Phase 4: Proof

### - [ ] Task 16: Walking-skeleton end-to-end test

**Description:** The single test that proves all three modules work together —
the scenario in `SPEC-portfolio.md` §Verification, verbatim.

**Acceptance criteria:**
- [ ] Full flow: A registers → logs in → creates "Retirement" (BRL) → creates a private CDB → `GET /portfolios` returns exactly that portfolio
- [ ] B registers → `GET /portfolios` returns `[]` → `GET /portfolios/<A's id>` returns 404 → `GET /instruments` does not list A's CDB
- [ ] Runs against a real database in CI

**Verification:**
- [ ] `npm run test:e2e` green from a clean database

**Dependencies:** Tasks 12, 15
**Files:** `test/e2e/walking-skeleton.e2e-spec.ts`
**Scope:** S

---

### - [ ] Task 17: CI pipeline

**Description:** Enforce the standing bar on every push so it cannot quietly erode.

**Acceptance criteria:**
- [ ] CI runs typecheck, lint, unit, integration and e2e
- [ ] Coverage gate at 80% global fails the build when unmet
- [ ] Postgres available to integration and e2e jobs
- [ ] `npx prisma migrate deploy` verified against an empty database

**Verification:**
- [ ] A deliberately failing test and a deliberate coverage drop both red the build

**Dependencies:** Task 16
**Files:** `.github/workflows/ci.yml`
**Scope:** S

---

## Checkpoint: Complete
- [ ] All acceptance criteria met across Tasks 1–17
- [ ] Walking skeleton passes end to end from a clean checkout
- [ ] Every entity in `ARCHITECTURE.md` §7 touched by this slice has a matching Prisma model
- [ ] Open questions in `tasks/plan.md` revisited — especially the **undecided frontend framework**, which blocks `reporting`
- [ ] Ready to specify `ledger`
