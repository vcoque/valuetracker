# Spec: `catalog`

Module `catalog` from [`CAPABILITY-MAP.md`](./CAPABILITY-MAP.md). Depends on:
`identity`. Project-wide stack, commands, structure, style, testing and
boundaries are defined once in [`SPEC.md`](./SPEC.md).

---

## Objective

Own the definition of *what can be held* — the securities and the reference data
they are denominated in — so that `portfolio` and `ledger` can reference an
instrument without knowing anything about its asset class.

This is where `ARCHITECTURE.md`'s class-table inheritance becomes code. It is the
module that determines whether adding a fifth asset class later is a one-table
change or a refactor.

**Not in scope:** prices (that is `market-data`), holdings (that is `ledger`),
corporate actions (defined by `market-data`, applied by `ledger`).

---

## Data Owned

Per `ARCHITECTURE.md` §7.1–§7.3 and §7.6–§7.10:

| Entity | Role |
|---|---|
| `currency` | ISO 4217 reference; seeded, not user-editable |
| `exchange` | Trading venues; seeded |
| `data_source` | Provenance registry; seeded |
| `instrument` | Base entity, `instrument_type` discriminator, nullable `owner_user_id` |
| `instrument_equity` | Specialization: ticker, exchange, ISIN, sector |
| `instrument_etf` | Specialization: ticker, exchange, benchmark index, expense ratio |
| `instrument_fixed_income` | Specialization: issuer, indexation, rate, maturity, day count |
| `instrument_crypto` | Specialization: symbol, network, contract address, decimals |

### The inheritance mapping is the hard part

Prisma has no native joined-table inheritance. The base and each specialization
are separate models joined by a 1:1 relation on `instrument_id`. Two consequences
the implementation must handle explicitly, because the ORM will not:

1. **Prisma cannot enforce "exactly one specialization row, matching
   `instrument_type`."** That invariant (`ARCHITECTURE.md` §8.6) must be enforced
   by a database `CHECK` constraint or trigger added in a hand-written migration,
   *and* by always creating base + specialization inside one transaction. An
   instrument with no specialization row, or with two, is a corrupt record.
2. **Reads need a discriminated union at the service boundary.** The public type
   is a TypeScript discriminated union on `instrumentType`, so callers get
   exhaustiveness checking. Leaking four optional relations to callers pushes the
   `undefined`-handling into every consumer and defeats the point of the model.

---

## API Surface

| Method | Path | Purpose | Auth |
|---|---|---|---|
| `GET` | `/currencies` | List supported currencies | Yes |
| `GET` | `/exchanges` | List exchanges | Yes |
| `GET` | `/instruments` | Search the catalog; filter by type, ticker, name | Yes |
| `GET` | `/instruments/:id` | One instrument with its specialization | Yes |
| `POST` | `/instruments` | Create a **private** instrument (fixed income) | Yes |
| `PATCH` | `/instruments/:id` | Update a private instrument the user owns | Yes |

`GET` returns public instruments (`owner_user_id IS NULL`) **union** the calling
user's private ones. `POST` may only create private instruments — the public
catalog is written by `market-data` ingestion and by seeds, never by an API
client.

---

## Acceptance Criteria

- [ ] All four specializations exist as separate tables with a 1:1 relation to `instrument`, per `ARCHITECTURE.md` §7.
- [ ] Creating an instrument writes base + specialization **atomically**; a failure in either leaves no partial row. Proven by an integration test that forces the second insert to fail.
- [ ] A database-level constraint rejects an `instrument` whose specialization does not match its `instrument_type`. Proven by raw SQL in an integration test, bypassing the service layer.
- [ ] `GET /instruments/:id` returns a discriminated union; adding a fifth `instrument_type` produces a **compile error** at every exhaustive switch until handled.
- [ ] A user cannot read, update or discover another user's private instrument — 404, not 403, so private instruments are not enumerable.
- [ ] `POST /instruments` rejects an attempt to create a public instrument (`owner_user_id = null`).
- [ ] Public uniqueness holds: `(exchange_code, ticker)` for equity/ETF and `(symbol, network)` for crypto are unique **among public instruments only** — two users may each hold a private CDB with the same name. Requires a partial unique index.
- [ ] `instrument.currency_code` and `exchange.currency_code` are FK-validated against `currency`.
- [ ] `is_variable_income` is true for equity/ETF/crypto and false for fixed income, enforced rather than trusted.
- [ ] Seeds load BRL/USD/EUR, the B3 exchange, and at least one data source.
- [ ] Adding a new asset class requires **one new table and one discriminator value** — no changes to existing tables. Demonstrated in the ADR, not merely claimed.

## Verification

```
npx prisma migrate reset && npx prisma db seed
npm test -- --selectProjects integration -- catalog     # constraints, atomicity, partial indexes
npm run test:e2e -- catalog                             # private-instrument isolation
```

Manual: create a private CDB as user A, confirm user B's `GET /instruments`
does not list it and `GET /instruments/:id` returns 404.

## Open Questions

- Does the fixed-income `indexation_type` need to be a lookup table rather than a
  string enum, so `valuation` can join it to an index series? Likely yes — revisit
  when `market-data` is specified.
- Should ETFs reuse `instrument_equity` after all? They are modelled separately in
  `ARCHITECTURE.md` §7.8; if the distinct fields go unused in practice, that is a
  simplification worth taking before the table has data.
- Ticker changes over time (`corporate_action` `TICKER_CHANGE`). The catalog
  currently stores one current ticker — historical ticker lookup may need a
  `instrument_ticker_history` table. Blocks nothing today; blocks accurate
  historical search later.
