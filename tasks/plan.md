# Implementation Plan: ValueTracker Walking Skeleton

## Overview

Build the walking skeleton defined in [`CAPABILITY-MAP.md`](../CAPABILITY-MAP.md):
the `identity`, `catalog` and `portfolio` modules, proven end to end. When this
plan completes, a user can register, log in, create a portfolio, add a private
fixed-income instrument, and read both back — with a second user provably unable
to see any of it.

This plan covers **backend only**. `ledger`, `market-data`, `valuation` and
`reporting` are not specified yet and are out of scope here.

Tasks are recorded in [`tasks/todo.md`](./todo.md).

## Architecture Decisions

Carried from [`SPEC.md`](../SPEC.md); repeated here only where they shape task order.

- **Modular monolith, not microservices.** One NestJS app, one database, module
  boundaries enforced by convention and review rather than network calls.
- **Prisma with hand-written constraint migrations.** Prisma has no joined-table
  inheritance, so the `instrument` hierarchy is four 1:1 relations plus a
  database `CHECK` constraint that Prisma cannot express. That constraint lives
  in a hand-edited migration.
- **Testcontainers over a mocked Prisma.** The invariants that matter — composite
  primary keys, partial unique indexes, `NUMERIC` rounding, the specialization
  `CHECK` — only hold in a real PostgreSQL. Mocking the ORM would test nothing.
- **Reference data before everything.** `currency` is a foreign key from `user`,
  `portfolio` and `instrument`. It must exist and be seeded before any of the
  three modules can be migrated.
- **Highest-risk work is de-risked in Phase 0 by a throwaway spike.** The Prisma
  inheritance mapping is the one decision that could invalidate the ORM choice.
  Proving it costs one file; discovering it in Phase 3 costs a rewrite.

## Dependency Graph

```
environment (Node 20, Docker daemon)
    │
    └── NestJS scaffold ── quality gates (lint, 3 Jest projects)
            │
            └── Prisma + Testcontainers harness
                    │
                    ├── [spike] class-table inheritance      ← de-risks Phase 3
                    │
                    └── reference data (currency, exchange, data_source)
                            │
                            └── identity (user, credential, session)
                                    │
                                    ├── portfolio ──┐
                                    │               ├── walking-skeleton E2E ── CI
                                    └── catalog ────┘
```

Implementation order follows this bottom-up. `portfolio` and `catalog` both
depend only on `identity` + reference data, so they are the one genuine
parallelization opportunity in this plan.

## Slicing

Phases 1–3 are vertical: each delivers a working, exercisable user capability
(register → log in → own a portfolio → own an instrument), not a horizontal layer.

Phase 0 is unavoidably horizontal — scaffold, ORM and reference data are shared
foundation with no user-visible behaviour. It is kept as small as possible and
every task in it still ends with something runnable.

## Task List

See [`tasks/todo.md`](./todo.md) for the full task detail. Summary:

| Phase | Tasks | Delivers |
|---|---|---|
| 0 — Foundation | 1–6 | Buildable, testable app with a real database and seeded reference data |
| 1 — `identity` | 7–10 | Register, log in, session cookie, guarded routes |
| 2 — `portfolio` | 11–12 | Owned portfolios with archive semantics |
| 3 — `catalog` | 13–15 | Instrument hierarchy and private instruments |
| 4 — Proof | 16–17 | End-to-end isolation test and CI enforcement |

## Parallelization

- **Sequential:** Phase 0 throughout; all migrations (they share one schema
  history and must be linearised).
- **Parallelizable:** Phase 2 (`portfolio`) and Phase 3 (`catalog`) after
  Checkpoint B — different tables, different modules, no shared code beyond
  `AuthGuard` and `currency`. Two agents can take them concurrently.
- **Needs coordination:** none, provided the `identity` public contract
  (`AuthGuard`, `CurrentUser`) is settled at Checkpoint B before both start.

## Risks and Mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Prisma cannot express the class-table inheritance cleanly | **High** — invalidates the ORM choice and reshapes `catalog` | Task 5 spike proves it before any real schema is written. Fallback: raw-SQL migrations with hand-written mappers, or reassess Drizzle. Decide at Checkpoint A, not Phase 3. |
| Node 18 → 20 upgrade disrupts the developer's other local work | Medium — blocks all work until resolved | Use `nvm`/`volta` with a committed `.nvmrc`; never a system-wide replacement |
| Docker daemon unavailable (currently not running) | Medium — all integration and E2E tests fail | Task 1 verifies it. Fallback: a `docker-compose.yml` Postgres with `DATABASE_URL`, at the cost of test isolation |
| TypeScript 6.0.3 misbehaves with NestJS decorator metadata | Medium — toolchain churn | Verified `ts-jest@29.4.12` accepts `<7`. If 6.x misbehaves, drop to `5.9.3`; do **not** go to 7.x, which ts-jest rejects outright |
| `argon2` native module fails to build on the target platform | Low | `bcrypt` (cost ≥ 12) fallback already sanctioned in `SPEC-identity.md` |
| Partial unique indexes for public-only instrument uniqueness are easy to get subtly wrong | Medium — silent data corruption in `catalog` | Task 13 requires an integration test that proves two users may hold same-named private instruments while public duplicates are rejected |
| `identity` adds three tables not in the approved ER model | Medium — scope/approval gap | Task 7 is an explicit gate: `ARCHITECTURE.md` is updated and approved before the migration is written |

## Open Questions

Blocking nothing in this plan, but unresolved:

1. **Frontend framework — still undecided.** Raised, not answered. Does not block
   the walking skeleton (backend only), but `CAPABILITY-MAP.md` has no `web-ui`
   module, and the original requirement asks for graphs. Needs a decision before
   `reporting` is specified.
2. Session strategy and registration openness — recommendations given in
   `SPEC-identity.md` §"Decisions Required"; confirm before Task 8.
3. `SPEC.md` open questions 1–2 (market-data provider, CDI/IPCA/SELIC index
   source) block `market-data` and `valuation`, not this plan.
4. Deployment target and CI provider — Task 17 assumes GitHub Actions. Change it
   if that is wrong.
