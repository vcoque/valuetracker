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
**Files:** `eslint.config.mjs`, `.prettierrc`, `jest.config.ts`, `apps/api/src/app.spec.ts`
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
**Files:** `apps/api/prisma/schema.prisma`, `apps/api/src/shared/prisma/prisma.service.ts`, `apps/api/src/shared/config/`, `apps/api/test/integration-setup.ts`
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

**Description:** `currency`, `exchange` and `data_source` per
`SPEC-catalog.md`, with a seed. These are foreign keys from `user`, `portfolio` and
`instrument`, so nothing downstream can migrate without them.

**Acceptance criteria:**
- [ ] Three tables migrated with the documented columns and keys
- [ ] Seed loads BRL, USD, EUR; the B3 exchange; at least one data source
- [ ] Seed is idempotent — running twice leaves the same rows
- [ ] `GET /currencies` and `GET /exchanges` return seeded data

**Verification:**
- [ ] `npx prisma migrate reset && npx prisma db seed` twice, then integration test asserts row counts

**Dependencies:** Task 4
**Files:** `apps/api/prisma/schema.prisma`, `apps/api/prisma/seed.ts`, `apps/api/src/modules/catalog/reference.controller.ts`, `*.int-spec.ts`
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
which the original ER model deliberately excluded as an auth concern. That is a
data-model change and falls under *Ask first* in `SPEC.md` §Boundaries.

**Largely done ahead of time:** both tables are specified in `SPEC-identity.md`
and present in `ARCHITECTURE.md` §5's ER diagram, and the token design is
recorded in [ADR 0003](../docs/adr/0003-jwt-access-tokens-with-refresh-sessions.md).
What remains is the explicit human sign-off before the migration is written.

**Acceptance criteria:**
- [x] `SPEC-identity.md` documents all three entities with full attribute tables, and `ARCHITECTURE.md` §5's ER diagram includes them
- [x] A mermaid diagram includes them and still parses
- [ ] Human has approved the addition — specifically that `session` is a *refresh-token store* (`token_hash`, `client_type`, `replaced_by_id`), not a cookie-session table

**Verification:**
- [ ] Mermaid blocks parse; entity dictionary and diagrams stay consistent

**Dependencies:** None (can run during Phase 0)
**Files:** `SPEC-identity.md`, `ARCHITECTURE.md`
**Scope:** XS

---

### - [ ] Task 8: identity schema and password hashing

**Description:** Migrate `user`, `user_credential`, `session`. Implement hashing
as pure domain code with no I/O so it is unit-testable in isolation.

`session` is a refresh-token store, not a cookie-session table — one row per
logged-in device, holding a SHA-256 hash of the token and a rotation chain. See
[ADR 0003](../docs/adr/0003-jwt-access-tokens-with-refresh-sessions.md).

**Acceptance criteria:**
- [ ] argon2id hashing for **passwords** (bcrypt cost ≥ 12 fallback if the native build fails)
- [ ] SHA-256 for the **refresh token** — deliberately not argon2id; the token is 256 bits of server randomness, so a slow hash buys nothing and costs latency on every refresh
- [ ] `user.email` unique **by database constraint**, proven by a direct duplicate insert
- [ ] Credentials in a separate table; the hash is never selectable via a user query
- [ ] `session.token_hash` unique; `replaced_by_id` self-references `session` for the rotation chain
- [ ] `base_currency_code` FK-validated against `currency`

**Verification:**
- [ ] `npm test -- --selectProjects unit -- identity` — hash/verify round trip
- [ ] `npm test -- --selectProjects integration -- identity` — unique constraint

**Dependencies:** Tasks 6, 7
**Files:** `apps/api/prisma/schema.prisma`, `apps/api/src/modules/identity/domain/password.ts`, `token.ts`, `*.spec.ts`, `identity.module.ts`, `*.int-spec.ts`
**Scope:** M

---

### - [ ] Task 9: Register and login

**Description:** `POST /auth/register` and `POST /auth/login`, both issuing an
access-token/refresh-token pair. Signup is open self-service — multi-user from
the first slice.

**Acceptance criteria:**
- [ ] Both endpoints create a `session` row storing only the SHA-256 hash of the refresh token, and return a signed EdDSA access token
- [ ] The access token carries `sub`, `sid`, `iat`, `exp`, `iss`, `aud` and nothing else — no email, no display name
- [ ] For `client_type = WEB` the refresh token is set as an `httpOnly; Secure; SameSite=Strict` cookie path-scoped to `/auth/refresh`, and never appears in a response body
- [ ] For `client_type = ANDROID` both tokens are returned in the body and no cookie is set
- [ ] Wrong password and unknown email return the **same** error and take **indistinguishable** time — no user enumeration through either channel
- [ ] Password policy enforced: minimum 12 characters
- [ ] Auth endpoints rate-limited per IP — open signup makes this first-slice, not hardening
- [ ] No password, hash or raw token appears in any response or log line

**Verification:**
- [ ] E2E: register → token pair issued → login → token pair issued, for both client types
- [ ] Integration test asserting the timing/response equivalence of the two failure modes
- [ ] Integration test asserting the raw refresh token appears nowhere in the `session` table

**Dependencies:** Task 8
**Files:** `apps/api/src/modules/identity/identity.controller.ts`, `identity.service.ts`, `dto/`, `apps/api/test/e2e/identity.e2e-spec.ts`
**Scope:** M

---

### - [ ] Task 10: AuthGuard, token refresh and rotation, profile

**Description:** `AuthGuard` and the `CurrentUser` decorator — the public contract
every other module consumes — plus `POST /auth/refresh`, `POST /auth/logout`,
`POST /auth/logout-all`, `GET /auth/me` and `PATCH /auth/me`.

**Acceptance criteria:**
- [ ] `AuthGuard` rejects missing, malformed, expired and wrongly-signed tokens with 401 — never 500
- [ ] A token forged with `alg: none`, with the wrong key, or with an unknown `kid` is rejected. One test per forgery
- [ ] `POST /auth/refresh` rotates: the presented token is revoked with `replaced_by_id` set, and a new pair issued
- [ ] **Reuse detection** — replaying an already-rotated refresh token revokes the whole chain for that user
- [ ] `POST /auth/logout` revokes the current session; `POST /auth/logout-all` revokes every session for the user
- [ ] `CurrentUser` exposes the authenticated user id to controllers
- [ ] `PATCH /auth/me` updates only `display_name`, `base_currency_code`, `timezone`

**Verification:**
- [ ] E2E covering every rejection case, the rotation round trip, and reuse detection
- [ ] E2E proving logout-all invalidates a *second* device's session, not just the caller's

**Dependencies:** Task 9
**Files:** `apps/api/src/modules/identity/auth.guard.ts`, `current-user.decorator.ts`, `identity.controller.ts`, `apps/api/test/e2e/identity.e2e-spec.ts`
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

**Description:** `portfolio` per `SPEC-portfolio.md`, with create, list and get.
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
**Files:** `apps/api/prisma/schema.prisma`, `apps/api/src/modules/portfolio/{portfolio.module,portfolio.service,portfolio.controller}.ts`, `dto/`
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
**Files:** `apps/api/prisma/schema.prisma` (migration), `portfolio.service.ts`, `portfolio.controller.ts`, `*.int-spec.ts`
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
**Files:** `apps/api/prisma/schema.prisma`, `apps/api/prisma/migrations/*/migration.sql` (hand-edited), `apps/api/src/modules/catalog/`, `*.int-spec.ts`
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
**Files:** `apps/api/src/modules/catalog/{catalog.service,catalog.controller}.ts`, `domain/instrument.ts`, `*.spec.ts`
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
**Files:** `apps/api/src/modules/catalog/catalog.service.ts`, `catalog.controller.ts`, `dto/`, `*.int-spec.ts`
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
**Files:** `apps/api/test/e2e/walking-skeleton.e2e-spec.ts`
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
- [ ] Every entity touched by this slice has a matching Prisma model
- [ ] Open questions in `tasks/plan.md` revisited — especially the **undecided frontend framework**, which blocks `reporting`
- [ ] Ready to specify `ledger`
