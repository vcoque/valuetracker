# Capability Map: ValueTracker

ValueTracker bundles several independently testable capabilities, so it is
decomposed into modules before any module is specified. This map is the index of
what exists — specs, plans and tasks select work by **module id**, never by
guessing which spec is active.

Module ids are stable, kebab-case, and are not renamed mid-initiative.

## Modules

| Module id | Responsibility | Depends on |
|---|---|---|
| `identity` | Accounts, authentication, sessions | — |
| `catalog` | Currencies, exchanges, instruments and their four type specializations | `identity` |
| `portfolio` | Portfolios: create, archive, base currency | `identity` |
| `ledger` | Positions, transactions, cost-basis engine, corporate-action application | `portfolio`, `catalog` |
| `market-data` | Price and FX ingestion, corporate-action feed, source precedence | `catalog` |
| `valuation` | Daily snapshot job, fixed-income accrual | `ledger`, `market-data` |
| `reporting` | Time-series and allocation read APIs for charts | `valuation` |

## Build order

```
identity ──┬─→ catalog ──┬─→ ledger ──┬─→ valuation ──→ reporting
           │             │            │
           └─→ portfolio ┘            │
                                      │
                    market-data ──────┘
```

Sequential: `identity` → (`catalog`, `portfolio` in parallel) → `ledger` →
`valuation` → `reporting`. `market-data` depends only on `catalog`, so it can be
built in parallel with `ledger`; both must land before `valuation`.

**Walking skeleton (current scope):** `identity` + `catalog` + `portfolio` —
a thin end-to-end slice proving the stack before the harder ledger work begins.

## Boundary decisions

Three calls in this map are non-obvious and are recorded here so they are not
silently revisited during implementation.

**`position` belongs to `ledger`, not `portfolio`.** A position is derived from
transactions — its `quantity`, `average_cost` and `cost_basis` are a cache the
cost-basis engine owns and maintains. Putting it in `portfolio` would split
ownership of a single invariant across two modules. `portfolio` therefore owns
only the portfolio record itself.

**`catalog` depends on `identity` solely because of private instruments.** A
user-specific fixed-income contract carries `instrument.owner_user_id`
(see `ARCHITECTURE.md` §6). The alternative — a separate `user-instrument`
module — would duplicate the entire instrument specialization hierarchy for one
nullable column. The dependency is the cheaper trade.

**`valuation` is separate from `ledger`.** The cost-basis engine is pure domain
logic with no I/O; the snapshot job is scheduled, reads market data, and writes
derived rows. They fail differently, are tested differently, and scale
differently. Merging them would make the cost-basis engine untestable without a
database.

## Interfaces

Dependency arrows point one way and there are no cycles. Where two modules meet,
the contract belongs to the **provider** module's spec — `identity` defines the
session contract that `catalog` and `portfolio` consume, not the reverse.

## Traceability

Every module spec is named `SPEC-<module-id>.md` and must trace to a module id in
this table. Project-wide concerns — stack, commands, structure, style, testing,
boundaries — live once in [`SPEC.md`](./SPEC.md) and are not repeated per module.

| Artifact | Status |
|---|---|
| [`ARCHITECTURE.md`](./ARCHITECTURE.md) | Approved — data model for all modules |
| [`SPEC.md`](./SPEC.md) | Project-wide spec |
| [`SPEC-identity.md`](./SPEC-identity.md) | Walking skeleton |
| [`SPEC-catalog.md`](./SPEC-catalog.md) | Walking skeleton |
| [`SPEC-portfolio.md`](./SPEC-portfolio.md) | Walking skeleton |
| `SPEC-ledger.md` | Not yet written |
| `SPEC-market-data.md` | Not yet written |
| `SPEC-valuation.md` | Not yet written |
| `SPEC-reporting.md` | Not yet written |
