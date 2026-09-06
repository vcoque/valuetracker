# Spec: ValueTracker (project-wide)

Project-wide contract shared by every module. Module-specific objectives and
acceptance criteria live in `SPEC-<module-id>.md`, indexed by
[`CAPABILITY-MAP.md`](./CAPABILITY-MAP.md). The data model is
[`ARCHITECTURE.md`](./ARCHITECTURE.md) and is treated as settled.

---

## Objective

A personal portfolio management system. A user tracks several portfolios, each
holding investments of mixed classes — fixed income, stocks, ETFs, crypto —
enters holdings as transactions, and sees gains and losses charted over time.

**User:** an individual investor managing their own money across goal-based
portfolios (retirement, a child's education, an emergency fund). Not an advisor,
not an institution.

**Success looks like:** the user enters a purchase once, and from then on the
system keeps the position's value current without further input, and can show
what it is worth and what it has earned on any date since.

**Not in scope:** trade execution, financial advice, tax filing, broker
integration, portfolio sharing between users.

### Assumptions

Recorded so they can be challenged rather than discovered later:

1. Brazilian market focus — B3, CDI/IPCA/SELIC indices, BRL as the common base
   currency. Multi-currency is supported, but BRL is the default.
2. One owner per portfolio. No sharing, no advisor/client roles.
3. Three clients, built in this order: HTTP API, then a web frontend, then a
   **native Android** application. iOS is not planned. A WebView shell was
   considered and rejected — see
   [ADR 0002](./docs/adr/0002-native-android-app-not-webview.md).
4. Personal tracking only — nothing here is a regulated financial product.
5. Backend-first. The HTTP API is the deliverable for the walking skeleton; the
   web and Android clients are later, separate efforts against the same
   contract.

---

## Tech Stack

| Concern | Choice | Version | Why |
|---|---|---|---|
| Runtime | Node.js | **≥ 20 LTS** | Required by NestJS 12 |
| Language | TypeScript | **6.0.3** | See the version traps below |
| Framework | NestJS on the Fastify adapter | **12.0.1** | Its module system maps 1:1 onto the capability map; DI keeps the cost-basis engine testable with zero I/O |
| Scheduling | `@nestjs/schedule` | **12.0.1** | Cron for `market-data` ingestion and the `valuation` snapshot job |
| ORM / migrations | Prisma | **7.10.0** | `Decimal` is decimal.js-backed and maps to Postgres `NUMERIC`; schema-as-source-of-truth with generated types |
| Toolchain host | Docker Engine + Compose v2 | **any current** | The only host dependency; Node and the build tools live in the image |
| Database | PostgreSQL | **16+** | `NUMERIC` for exact money, range partitioning for the time-series tables, partial indexes |
| Decimal math | `decimal.js` | **10.6.0** | Bundled with Prisma; used directly in pure domain code |
| Validation | `zod` | **4.5.4** | Runtime validation at the HTTP boundary, inferred into TS types |
| Logging | `pino` | **10.3.1** | Structured JSON logs |
| Unit/integration tests | Jest + ts-jest | **30.5.1** / **29.4.12** | NestJS's well-trodden path |
| Real-database tests | `@testcontainers/postgresql` | **12.1.0** | The model's constraints only hold in a real Postgres |
| HTTP tests | `supertest` | **7.2.2** | E2E against the running Nest app |

### Version traps — verified against the npm registry, not assumed

Three defaults are wrong and will break the build if taken at face value:

1. **`prisma@latest` resolves to `8.0.0-rc.12`, a release candidate**, while
   `@prisma/client@latest` is `7.10.0`. A plain
   `npm install prisma @prisma/client` installs a mismatched RC/stable pair.
   **Pin both to exactly `7.10.0`.**
2. **`typescript@latest` resolves to `7.0.2`, but `ts-jest@29.4.12` declares
   `typescript: ">=4.3 <7"`.** TypeScript 7 breaks the test toolchain outright.
   **Pin TypeScript to `6.0.3`.**
3. **NestJS 12 declares `engines: { node: ">= 20" }`.** Confirm the local Node
   version before the first install; Node 18 is EOL and will not work.

Record any change to these pins as an ADR — they were chosen against evidence,
not preference.

### Deliberately excluded

No GraphQL (REST is sufficient for a charting client), no message broker (the
scheduler covers ingestion), no Redis (nothing needs a shared cache yet), no
microservices (a modular monolith with enforced module boundaries is the right
size for this system).

---

## Commands

```
Install:      npm ci
All commands run inside the toolchain container -- `./scripts/dev.sh <cmd>`
wraps `docker compose`. Nothing but Docker is required on the host.

Setup:        ./scripts/check-env.sh --init-env   # per-machine .env.dev.local
              ./scripts/check-env.sh --full       # verify the toolchain
              ./scripts/dev.sh npm ci

Dev:          npm run start:dev            # watch mode, port 3000
Build:        npm run build                # tsc -> dist/
Start:        npm run start:prod           # node dist/main
Lint:         npm run lint                 # eslint --fix
Format:       npm run format               # prettier --write
Typecheck:    npm run typecheck            # tsc --noEmit

Test (all):   npm test
Unit only:    npm test -- --selectProjects unit
Integration:  npm test -- --selectProjects integration    # needs Docker
E2E:          npm run test:e2e                            # needs Docker
Coverage:     npm test -- --coverage

DB migrate:   npx prisma migrate dev --name <description>
DB deploy:    npx prisma migrate deploy                   # CI/production
DB client:    npx prisma generate
DB reset:     npx prisma migrate reset                    # destructive, local only
DB studio:    npx prisma studio
```

Integration and E2E tests start a real PostgreSQL via Testcontainers. Because
the suite itself runs inside a container, `compose.yaml` shares the host's
docker socket: the databases Testcontainers creates are *siblings* of the app
container, not children. They publish their ports on the host, so
`TESTCONTAINERS_HOST_OVERRIDE` tells the client where to dial. This is verified
by `./scripts/check-env.sh --full`.

The `db` service in `compose-dev.yaml` is for the development loop and
migrations only -- tests never use it, so a test run cannot corrupt development
data.

### Environments are named, never implicit

Compose loads `compose.yaml` and `.env` from the working directory by default,
which would make a bare `docker compose up` silently mean "development". Files
are therefore named for the environment they configure and passed explicitly:

| File | Committed | Contents |
|---|---|---|
| `compose-dev.yaml` | yes | Development orchestration |
| `Dockerfile.dev` | yes | Development/test toolchain image (not a deployment artifact) |
| `.env.dev` | **yes** | Shared, non-secret development configuration |
| `.env.dev.local` | no | Per-machine values only: `HOST_UID`, `HOST_GID`, `DOCKER_GID` |
| `.env.dev.local.example` | yes | Template for the above |

`scripts/_docker.sh` is the single place those names are written down. Every
interpolation in `compose-dev.yaml` uses `${VAR:?message}` rather than a
`:-default`, so a missing value fails loudly and names its own fix instead of
substituting something that happens to work on one machine.

A further environment (`compose-ci.yaml`, `.env.ci`, a production `Dockerfile`)
is added by the same rule; nothing is ever added to the dev files to serve it.

---

## Project Structure

A monorepo on npm workspaces — see
[`docs/adr/0001-monorepo-with-npm-workspaces.md`](./docs/adr/0001-monorepo-with-npm-workspaces.md).

```
apps/
  api/                          NestJS + Prisma. The only workspace in the
    src/                        walking-skeleton plan.
      main.ts                   Bootstrap, Fastify adapter, global pipes
      app.module.ts             Root module; imports one module per capability
      modules/
        identity/               One directory per capability-map module id
          identity.module.ts
          identity.controller.ts
          identity.service.ts
          dto/                  Request/response shapes, from @valuetracker/contract
          domain/               Pure logic, no I/O, no framework imports
          *.spec.ts             Unit tests, colocated with their subject
          *.int-spec.ts         Integration tests, real Postgres
        catalog/
        portfolio/
        ledger/                 Not yet built
        market-data/            Not yet built
        valuation/              Not yet built
        reporting/              Not yet built
      shared/
        prisma/                 PrismaService, transaction helpers
        money/                  Money and Quantity value objects over Decimal
        config/                 Typed, zod-validated env configuration
        http/                   Filters, interceptors, zod validation pipe
    prisma/
      schema.prisma             Single schema; entities per each SPEC-*.md
      migrations/               Generated, committed, never hand-edited
      seed.ts                   Currencies, exchanges, reference data
    test/
      e2e/                      *.e2e-spec.ts, full HTTP through a real database
      fixtures/                 Shared builders and factories

  web/                          Web frontend. Not yet specified.
  mobile/                       Native Android. Created when that work starts.

packages/
  contract/                     zod schemas + inferred types. The API validates
                                with these; every client infers from them. One
                                definition, never a copy.

docs/
  adr/                          Architecture decision records
tasks/                          plan.md and todo.md
```

**Workspace boundary rule.** `apps/*` may depend on `packages/*`. No app depends
on another app, and no package depends on an app. `packages/contract` imports
nothing from the API — it is schemas and types only, so a client can consume it
without pulling in NestJS or Prisma.

**Money never crosses the wire as a number.** Monetary and quantity values are
serialised as decimal strings, already aggregated and already converted to the
portfolio's base currency. Clients format; clients do not compute. See
`SPEC-reporting.md`.

**Mobile does not run in the container toolchain.** Metro and an Android
emulator are host-native. `.nvmrc` exists for that case; every other workspace
runs through `./scripts/dev.sh`.

**Module boundary rule.** A module imports another module's *public service*, and
nothing else. Reaching into another module's `domain/`, `dto/` or Prisma models
directly is a boundary violation. `shared/` is importable by any module;
`shared/` imports no module.

---

## Code Style

One example beats three paragraphs. This is the target:

```ts
// src/modules/portfolio/portfolio.service.ts
import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../shared/prisma/prisma.service';
import type { CreatePortfolioInput } from './dto/create-portfolio.dto';
import type { Portfolio } from '@prisma/client';

@Injectable()
export class PortfolioService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Base currency is immutable after creation: changing it would invalidate
   * every stored snapshot (`SPEC-valuation.md`).
   */
  async create(userId: string, input: CreatePortfolioInput): Promise<Portfolio> {
    return this.prisma.portfolio.create({
      data: {
        userId,
        name: input.name,
        objective: input.objective,
        baseCurrencyCode: input.baseCurrencyCode,
        targetDate: input.targetDate ?? null,
      },
    });
  }

  async findOwnedById(userId: string, id: string): Promise<Portfolio> {
    const portfolio = await this.prisma.portfolio.findFirst({
      where: { id, userId, archivedAt: null },
    });
    if (portfolio === null) {
      throw new NotFoundException(`Portfolio ${id} not found`);
    }
    return portfolio;
  }
}
```

**Conventions.**

- **Money and quantities are never `number`.** Use Prisma `Decimal` at the
  boundary and the `Money` / `Quantity` value objects in domain code. A `number`
  in a monetary position is a review blocker, not a nit.
- Explicit return types on every exported function. No inferred public API.
- `strict: true`. No `any`, no non-null `!` assertions — narrow instead.
- Ownership is scoped in the query (`where: { id, userId }`), never checked
  after fetching. This is the pattern that prevents horizontal privilege
  escalation, and it is not optional.
- Files, directories and Prisma model fields: the database is `snake_case`
  (per `ARCHITECTURE.md`), TypeScript is `camelCase`, mapped with Prisma's
  `@map` / `@@map`. Never rename an entity between the two.
- Comments explain *why*, and cite the spec section when encoding a rule.
  Comments restating *what* the code does get deleted in review.
- Errors are typed Nest exceptions, never bare `throw new Error`.

---

## Testing Strategy

Jest with three projects, selectable independently so the fast suite stays fast.

| Level | Location | Runs against | Purpose |
|---|---|---|---|
| Unit | `src/**/*.spec.ts` | Nothing — pure functions | Domain logic, cost-basis math, accrual formulas |
| Integration | `src/**/*.int-spec.ts` | Real Postgres via Testcontainers | Repositories, constraints, transactions, migrations |
| E2E | `test/e2e/*.e2e-spec.ts` | Full app + real Postgres | HTTP contracts, auth, ownership enforcement |

**Coverage:** 80% overall as the CI gate. Pure domain code — the cost-basis
engine, accrual, FX conversion — is held to **100% branch coverage**. That
asymmetry is deliberate: the arithmetic is where a silent error costs the user
real money, and it is the cheapest code in the system to test exhaustively.

**Non-negotiables.**

- Every monetary calculation is tested against a hand-computed expected value
  written as a string literal (`'39.398667'`), never one produced by the code
  under test.
- The worked examples in `SPEC-ledger.md` are ported verbatim into the
  `ledger` test suite as executable specifications.
- The structural invariants declared in each module spec get an integration test each
  that proves the *database* rejects the violation — not merely that the service
  refuses to attempt it.
- Bug fixes start with a failing test that reproduces the bug.
- No mocking of Prisma in integration tests. Testcontainers exists so that
  composite primary keys, partial indexes and `NUMERIC` rounding behave as they
  will in production.

---

## Boundaries

**Always:**
- Run `npm run typecheck && npm test && npm run lint` before any commit.
- Use exact decimal types for money and quantities.
- Scope every user-owned query by `userId` in the `where` clause.
- Update the owning `SPEC-*.md` *before* changing `schema.prisma`, and keep the two in step.
- Update `ARCHITECTURE.md` too when a change adds, removes or re-links an entity — it holds the complete ER diagram.
- Write an ADR in `docs/adr/` for any decision that contradicts this spec.
- Keep migrations forward-only and reversible in effect.

**Ask first:**
- Any change to `prisma/schema.prisma` or the ER model.
- Adding a runtime dependency.
- Changing the pinned versions in the Tech Stack table.
- Introducing a new capability-map module or changing a module boundary.
- Changing an existing HTTP contract that a client may depend on.
- Anything touching authentication or session handling.

**Never:**
- Commit secrets, `.env` files, API keys or provider credentials.
- Use `number` or `parseFloat` for a monetary or quantity value.
- Hand-edit a generated migration after it has been applied anywhere.
- Delete or `.skip` a failing test to reach green.
- Convert a historical amount using today's FX rate (`ARCHITECTURE.md` §6.1).
- Write to snapshot tables from anywhere but the `valuation` job — they are
  derived, and nothing else may treat them as authoritative.
- Store a plaintext or reversibly-encrypted password.

---

## Success Criteria

Project-level. Module-level criteria live in each module spec.

- [ ] `./scripts/dev.sh npm ci && ./scripts/dev.sh npm run build && ./scripts/dev.sh npm test` passes from a clean checkout, with Docker as the only host dependency.
- [ ] `npx prisma migrate deploy` builds the full schema described across the `SPEC-*.md` files on an empty database.
- [ ] Every entity in `ARCHITECTURE.md` §7's ownership index has a Prisma model whose field names map to the columns its owning spec documents.
- [ ] The walking skeleton runs end to end: register → authenticate → create a portfolio → add an instrument → read it back scoped to that user.
- [ ] A second user cannot read, modify or discover the first user's portfolio; proven by an E2E test, not by inspection.
- [ ] CI enforces typecheck, lint, unit, integration and coverage gates on every push.

---

## Open Questions

Unresolved, needing a decision before the module each one blocks:

| # | Question | Blocks | Notes |
|---|---|---|---|
| 1 | Which market-data provider, and what are its rate limits and licensing terms? | `market-data` | B3 has no free official EOD feed; crypto and FX are easier. Licensing may constrain redistribution. |
| 2 | Which index series supplies CDI/IPCA/SELIC for fixed-income accrual? | `valuation` | Fixed income is accrued, not marked to market (`SPEC-valuation.md`) — this is a hard dependency, not a nice-to-have. |
| ~~3~~ | ~~Session strategy~~ | — | **Resolved.** JWT access tokens with server-side refresh sessions — [ADR 0003](./docs/adr/0003-jwt-access-tokens-with-refresh-sessions.md). Assumption 3 (web-only) is withdrawn: a native Android client is planned. |
| ~~4~~ | ~~Registration model~~ | — | **Resolved.** Open self-service signup, email + password, multi-user from the start. Email verification deferred; rate limiting is not — [ADR 0003](./docs/adr/0003-jwt-access-tokens-with-refresh-sessions.md). |
| 5 | Cash accounts — confirmed out of scope for v1? | `valuation`, `reporting` | Without them, true IRR is not computable and TWR is approximate (`ARCHITECTURE.md` §9). Worth confirming before reporting is promised. |
| ~~6~~ | ~~CI provider~~ | — | **Resolved.** GitHub Actions. Deployment target still open, but it does not block the walking skeleton. |
| 7 | Which frontend framework for `apps/web`, and which native toolchain for `apps/mobile`? | `web`, `mobile` | Neither blocks the backend. Build order is backend → web → Android. |
