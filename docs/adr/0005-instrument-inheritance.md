# ADR 0005 — Class-table inheritance for `instrument` on Prisma 7

- **Status:** Accepted
- **Date:** 2026-09-07
- **Decision:** **GO** — Task 13 (`catalog`) proceeds on Prisma 7 + hand-authored
  constraint SQL.
- **Amends:** `SPEC.md` §Boundaries ("Hand-edit a generated migration after it
  has been applied anywhere") — see "Deviation from SPEC.md" below.
- **Settles:** `tasks/plan.md` §Risks — "Prisma cannot express the class-table
  inheritance cleanly." It can, with the caveats recorded here.

## Context

`SPEC-catalog.md` models the securities catalog as class-table (joined-table)
inheritance: one base `instrument` row and exactly one specialization row
(`instrument_equity` / `_etf` / `_fixed_income` / `_crypto`) that shares its
primary key. Three invariants that spec calls out are things an ORM will not do
for you:

1. **Exactly one specialization row, matching the `instrument_type`
   discriminator.** Neither zero nor two is a valid record.
2. **Public natural-key uniqueness** — `(exchange_code, ticker)` for equity/ETF,
   `(symbol, network)` for crypto — that applies **only** to rows with
   `owner_user_id IS NULL`, so two users may each hold a private instrument with
   the same identifiers.
3. **A discriminated union at the service boundary**, so callers get
   exhaustiveness checking instead of four optional relations.

This is the single highest-risk decision in the project: if Prisma could not
express the shape, the ORM choice was invalidated and `catalog` reshaped. Task 5
is a throwaway spike that settles it before Task 13 depends on it.

## What the spike did

A throwaway spike (three files, since deleted — commit `6b76f7d` preserves the
runnable version; Ruling S9):

- `spike.prisma` — a Prisma schema modelling the hierarchy as a base model with
  three optional 1:1 relations, each specialization keyed by `@id` on the shared
  `instrument_id`. **Not** added to `apps/api/prisma/schema.prisma`, never
  migrated, never generated into the app client.
- `instrument-inheritance.int-spec.ts` — issues the DDL below by hand via
  `$executeRawUnsafe` against a **real Postgres 17** (the Task 4 Testcontainers
  harness), then proves behaviours 1–3. The DDL is the **structural skeleton**
  of what a Task 13 migration would carry — it omits `instrument_etf`,
  `data_source_id`, the `is_variable_income` CHECK, and trims payload columns.
- `instrument-union.spec.ts` — the discriminated union, an exhaustive `switch`
  with `default: assertNever(x)`, and a `// @ts-expect-error` fifth-case proof.

### Hand-authored SQL (the parts Prisma cannot express)

Discriminator as a **lookup table**, not a `CHECK (... IN (...))` list, so adding
an asset class is an `INSERT`, not an `ALTER` of an existing table:

```sql
CREATE TABLE instrument_type (code text PRIMARY KEY);
```

Base table carries a `UNIQUE (id, instrument_type)` — the target for a composite
foreign key from each specialization:

```sql
CREATE TABLE instrument (
  id uuid PRIMARY KEY,
  instrument_type text NOT NULL REFERENCES instrument_type(code),
  owner_user_id uuid,
  ... ,
  CONSTRAINT instrument_id_type_uk UNIQUE (id, instrument_type)
);
```

Each specialization pins its own discriminator and re-declares the composite FK,
so a specialization row **cannot** claim a type its base row does not have:

```sql
CREATE TABLE instrument_equity (
  instrument_id  uuid PRIMARY KEY REFERENCES instrument(id) ON DELETE CASCADE,
  instrument_type text NOT NULL DEFAULT 'EQUITY',
  owner_user_id  uuid,               -- denormalised, trigger-maintained
  ticker         varchar(16) NOT NULL,
  exchange_code  varchar(16) NOT NULL REFERENCES exchange(code),
  ...,
  CONSTRAINT instrument_equity_type_chk CHECK (instrument_type = 'EQUITY'),
  CONSTRAINT instrument_equity_matches_base
    FOREIGN KEY (instrument_id, instrument_type)
    REFERENCES instrument (id, instrument_type)
);
```

"Exactly one" — the half the composite FK does **not** cover (it allows *zero*) —
is a **deferred constraint trigger** on `instrument`:

```sql
CREATE CONSTRAINT TRIGGER instrument_one_specialization
  AFTER INSERT ON instrument INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION spike_require_one_specialization();
-- the function counts rows across the specialization tables for NEW.id and
-- RAISE EXCEPTION ... USING ERRCODE = 'check_violation' when the count <> 1.
```

Partial unique indexes for the public natural key. Their predicate column
(`owner_user_id`) lives on `instrument` while the key columns live on the
specialization, so `owner_user_id` is **denormalised onto the specialization**
and kept honest by a `BEFORE INSERT/UPDATE` trigger that copies it from the base
row:

```sql
CREATE UNIQUE INDEX instrument_equity_public_natural_key
  ON instrument_equity (exchange_code, ticker) WHERE owner_user_id IS NULL;
CREATE UNIQUE INDEX instrument_crypto_public_natural_key
  ON instrument_crypto (symbol, network)       WHERE owner_user_id IS NULL;
```

## Findings

| # | Behaviour | How proven | Result |
|---|---|---|---|
| 1 | Base + specialization as a **1:1 relation**, created and read back | `prisma validate` accepts `spike.prisma` (shared-PK 1:1 relations); a `$transaction` writes base + `instrument_equity` and a join reads back exactly one combined row | **PASS** |
| 2 | DB rejects a **mismatched** specialization, and **zero / two** rows | Raw SQL, bypassing any service layer: `EQUITY` base + `instrument_fixed_income` row → **SQLSTATE 23503** (composite FK); base with no specialization, `SET CONSTRAINTS ALL IMMEDIATE` → **SQLSTATE 23514** (`RAISE` from the deferred trigger, message "exactly one is required"); `EQUITY` base + second `instrument_crypto` row → **23503**. In every case the row does not land. | **PASS** |
| 3 | **Partial unique index** — public rows only | Two different `owner_user_id`s each insert an equity with `(B3, MGLU3)` → both succeed; a second `owner_user_id IS NULL` row with the same key → **SQLSTATE 23505**. Same shape proven for crypto `(symbol, network)`. | **PASS** |
| 4 | **Discriminated union** with exhaustiveness | `describeInstrument` switches on `instrumentType` with `default: assertNever(x)` and compiles. A fifth member `InstrumentFund` left unhandled: with `// @ts-expect-error` removed, `npm run typecheck` fails with **`TS2345: Argument of type 'InstrumentFund' is not assignable to parameter of type 'never'`** at the `assertNever` call. Restored, typecheck passes. Adding `case 'FUND':` would instead trip `TS2578` (unused directive) — either way the compiler blocks an unhandled fifth type. | **PASS** |

Every violation in behaviour 2 and 3 is rejected **by the database**, not by
application code — the test issues raw `INSERT`s with no service or repository in
the path.

## Decision — GO

**Keep Prisma 7 for `catalog`.** The hierarchy is expressible:

- Prisma expresses base + specialization as 1:1 relations on the shared primary
  key **in the schema language** — `prisma validate` accepts it. The generated
  client's nested `create` / `include` was **not** exercised by this spike (see
  Consequences).
- The three invariants Prisma cannot state are enforceable with **standard,
  declarative Postgres**: a discriminator lookup table, a composite
  `UNIQUE` + composite `FOREIGN KEY` per specialization, one deferred constraint
  trigger for "exactly one", and partial unique indexes over a
  trigger-maintained denormalised `owner_user_id`. No extensions, no `plpgsql`
  beyond two tiny trigger functions.
- Atomicity is a `prisma.$transaction` around the base write and the
  specialization write — the same transaction the deferred trigger needs.

### Adding a new asset class = one table + one row, no existing-table changes

Per `SPEC-catalog.md` ("Adding a new asset class ... No existing table
changes"), demonstrated by the spike's structure rather than claimed:

- `INSERT INTO instrument_type (code) VALUES ('FUND')` — a row, not an `ALTER`.
- `CREATE TABLE instrument_fund (instrument_id uuid PRIMARY KEY REFERENCES
  instrument(id) ..., instrument_type text NOT NULL DEFAULT 'FUND'
  CHECK (instrument_type = 'FUND'), <fund columns>, composite FK to
  instrument(id, instrument_type))` — one new table.
- One TypeScript union member `InstrumentFund`; every exhaustive `switch` then
  fails to compile until it handles `'FUND'` (behaviour 4).

The **only** touch-point on an existing object is the `spike_require_one_specialization()`
trigger **function** body, which sums a count per specialization table. That is a
`CREATE OR REPLACE FUNCTION` — no table is altered. Task 13 can remove even that
edit by driving the count from the `instrument_type` registry (store the child
table name on the lookup row and count with dynamic SQL), making a new class a
pure `INSERT` + `CREATE TABLE`.

## Deviation from `SPEC.md` (Ruling S7)

`SPEC.md` §Boundaries says migrations are "never hand-edited" and its Never list
says "Hand-edit a generated migration **after it has been applied anywhere**."
The CHECK constraint, the composite FK, the constraint trigger and the partial
unique indexes above **cannot** be produced by `prisma migrate` — Prisma has no
syntax for a partial index, a composite FK to a non-PK unique key, or a trigger.
Task 13 will **hand-author this SQL into the migration file before it is first
applied**. This is sanctioned (Ruling S7): it does not edit an
already-applied migration, and the Testcontainers harness runs `prisma migrate
deploy` on the committed files exactly as a deployment would, so a hand-authored
migration that does not replay is caught by the integration suite.

## Consequences

- **OPEN RISK.** The generated Prisma client's nested `create` / `include`
  against the shared-PK 1:1 relations is **unproven** — the spike exercised only
  `prisma validate` (schema language) and a raw-SQL `$transaction` + join
  round-trip. Task 13 **must** cover a real
  `prisma.instrument.create({ data: { equity: { create: … } } })` and an
  `include`-based read with an acceptance test. If the codegen misbehaves
  against a composite-FK / shared-PK layout, the fallback is an explicit
  two-write `$transaction` and a hand mapper — which does not change the GO
  decision, only the amount of Prisma sugar Task 13 gets to use.
- Task 13 owns: the four Prisma models, the hand-authored constraint SQL in the
  first `catalog` migration, an atomic `$transaction` create path, and a mapper
  producing the discriminated union for reads.
- `is_variable_income` (true for equity/ETF/crypto, false for fixed income,
  never trusted from a client — `SPEC-catalog.md` AC) is the same technique:
  a `CHECK (is_variable_income = (instrument_type <> 'FIXED_INCOME'))` on
  `instrument`, hand-authored. Not exercised by this spike; noted so Task 13
  does not rediscover it.
- The denormalised `owner_user_id` on specialization tables is load-bearing for
  the partial indexes. Its trigger must also fire on `UPDATE` of the base
  `owner_user_id` if an instrument can ever change ownership; `SPEC-catalog.md`
  has no such transition today, so a `BEFORE UPDATE` on the base propagating the
  change is a future item, not a Task 13 blocker.
  - **Resolved (final-review Ruling S14, won't-build-until-needed):** this
    deferred item was carried forward to Task 15 without ever being scheduled
    or built. The final whole-branch review confirmed no endpoint on this
    branch can change `owner_user_id` after creation — `POST`/`PATCH
    /instruments`'s request schemas are `.strict()` and simply don't accept
    that field (`SPEC-catalog.md` §Structural invariants owned here) — so a
    propagation trigger would guard a mutation path that doesn't exist. It
    was deliberately **not** built. Revisit only if a future task adds an
    ownership-transfer capability; add the trigger at that time, not before.
- Deferred-constraint failures surface through Prisma at `COMMIT` as the bare
  `RAISE` message (no SQLSTATE). Code that needs to branch on "exactly one"
  violations should `SET CONSTRAINTS ALL IMMEDIATE` before commit, or match on
  the constraint name.

## Alternatives considered

- **Single-table inheritance** (one wide `instrument` table, nullable per-class
  columns). Rejected: `SPEC-catalog.md` explicitly models separate tables, ETF
  and fixed-income column sets barely overlap, and `NOT NULL` per class becomes
  unenforceable.
- **Drop Prisma for raw SQL + hand mappers** (`tasks/plan.md` fallback).
  Not needed — Prisma expresses the relations and does the 90% (CRUD, the 1:1
  reads, transactions); only the constraint DDL is hand-written, which it would
  be under any ORM.
- **Reassess Drizzle.** Not needed for the same reason; deferred as a
  non-decision.
