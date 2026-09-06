# Spec: `reporting`

Module `reporting` from [`CAPABILITY-MAP.md`](./CAPABILITY-MAP.md). Depends on:
`valuation`. Project-wide stack, commands, structure, style, testing and boundaries
are defined once in [`SPEC.md`](./SPEC.md).

> **Status: data model only.** This module is not in the walking-skeleton plan
> ([`tasks/plan.md`](./tasks/plan.md)). Its entities and invariants are recorded
> here — moved out of `ARCHITECTURE.md` so they sit with the module that owns
> them — but its API surface, acceptance criteria and open decisions are not yet
> specified. Do not implement from this file; specify it first.

---

## Objective

Serve the time-series and allocation data that the web and Android clients draw
charts from.

---

## Data Owned

**None.** `reporting` owns no tables. It is a read layer over the snapshot tables
in `SPEC-valuation.md`, plus whatever pre-aggregation those queries need.

---

## Standing Design Rule

**The API returns display-ready decimal values; clients format but never
compute.** `SPEC.md` forbids `number` for monetary quantities server-side. A
JavaScript or Kotlin client that does arithmetic on a JSON number reintroduces
exactly the floating-point error that rule exists to prevent — and with a web
client and an Android client, it would reintroduce it twice, inconsistently.

Concretely: monetary and quantity values cross the wire as **strings**, already
aggregated and already converted to the portfolio's base currency. Clients apply
`Intl.NumberFormat` or its Android equivalent and nothing more.

This is also what keeps charting tractable on Android, where the charting
ecosystem is materially weaker than the web's: the client receives a series it
can plot directly rather than a dataset it must reduce.

---

## Not Yet Specified

Deliberately absent until this module is planned: API surface, acceptance
criteria, verification commands, and the module-level decisions each would
force. Writing them now would be inventing requirements ahead of the evidence
the walking skeleton is meant to produce.


## Open Questions

- Without cash accounts, this module cannot honestly report money-weighted return
  (IRR), and time-weighted return is approximate. Decide whether that is
  acceptable, or add cash accounts first — see `ARCHITECTURE.md` §9.
- Benchmark comparison (IBOVESPA, CDI) needs a benchmark series and a
  portfolio-to-benchmark association. Neither exists yet.
