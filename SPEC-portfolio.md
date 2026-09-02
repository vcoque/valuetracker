# Spec: `portfolio`

Module `portfolio` from [`CAPABILITY-MAP.md`](./CAPABILITY-MAP.md). Depends on:
`identity`. Project-wide stack, commands, structure, style, testing and
boundaries are defined once in [`SPEC.md`](./SPEC.md).

---

## Objective

Own the portfolio record — the container a user creates for a goal ("Faculdade
da Ana", "Aposentadoria") and the declaration of the currency its results are
reported in.

This module is deliberately small. It owns the portfolio row and its ownership
rules, and nothing else: positions belong to `ledger`, because they are derived
from transactions and the cost-basis engine maintains them
(see `CAPABILITY-MAP.md`, boundary decisions).

**Not in scope:** positions, holdings, transactions, valuations, allocation
targets, sharing.

---

## Data Owned

`portfolio`, exactly as specified in `ARCHITECTURE.md` §7.5. No new entities.

The two constraints that carry real weight:

**`base_currency_code` is immutable after creation.** Changing it would
invalidate every stored snapshot, since snapshots record values already converted
into that currency (`ARCHITECTURE.md` §5.1). The API must reject the change
rather than silently accept it — a user who wants a different reporting currency
creates a new portfolio.

**Portfolios are archived, never deleted,** while any transaction references them
(`ARCHITECTURE.md` §8.6). `archived_at` is the soft-delete marker, and every
default query filters `archived_at IS NULL`.

---

## API Surface

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/portfolios` | List the caller's active portfolios |
| `GET` | `/portfolios/:id` | One portfolio the caller owns |
| `POST` | `/portfolios` | Create |
| `PATCH` | `/portfolios/:id` | Update `name`, `description`, `objective`, `target_date` |
| `POST` | `/portfolios/:id/archive` | Archive (soft delete) |
| `POST` | `/portfolios/:id/unarchive` | Restore |

All authenticated. `?includeArchived=true` on the list endpoint returns archived
portfolios too.

Exports a `PortfolioService.findOwnedById(userId, id)` for `ledger` to consume —
`ledger` never queries the `portfolio` table directly.

---

## Acceptance Criteria

- [ ] A user creates a portfolio with a name, objective and base currency, and it appears in their list.
- [ ] Every read and write is scoped by `userId` **in the `where` clause**, not checked after fetching (`SPEC.md`, Code Style).
- [ ] A user requesting another user's portfolio by id receives **404, not 403** — portfolio ids must not be enumerable.
- [ ] `PATCH` rejects any attempt to change `base_currency_code` or `user_id`, with a clear error naming the reason.
- [ ] `base_currency_code` is FK-validated against `currency` and rejects unknown codes.
- [ ] `(user_id, name)` is unique — a user cannot own two portfolios with the same name — enforced by a database constraint, proven by an integration test.
- [ ] The uniqueness constraint does **not** collide across users: two different users may each have a portfolio named "Retirement".
- [ ] Archiving sets `archived_at` and removes the portfolio from the default list without deleting the row; unarchiving restores it.
- [ ] `DELETE` is not implemented. Archive is the only removal path.
- [ ] `objective` accepts only the documented values (`RETIREMENT`, `EDUCATION`, `EMERGENCY`, `GENERAL`) or null.

## Verification

```
npm test -- --selectProjects unit -- portfolio
npm test -- --selectProjects integration -- portfolio   # unique constraint, archive semantics
npm run test:e2e -- portfolio                           # ownership isolation, 404 on foreign id
```

**Walking-skeleton end-to-end check** — the criterion that proves the whole slice:

```
register user A  ->  login  ->  create portfolio "Retirement" (BRL)
                             ->  create a private CDB instrument
                             ->  GET /portfolios returns exactly that portfolio
register user B  ->  login  ->  GET /portfolios returns []
                             ->  GET /portfolios/<A's id> returns 404
                             ->  GET /instruments does not list A's CDB
```

When that passes, `identity` + `catalog` + `portfolio` are proven together and
`ledger` can begin.

## Open Questions

- Should a portfolio declare a target amount alongside `target_date`, to support
  goal-progress reporting later? `ARCHITECTURE.md` §7.5 has `target_date` only.
  Adding `target_amount` is cheap now and awkward once snapshots exist.
- Is `objective` a fixed enum or user-defined free text? A fixed enum is proposed
  above; free text would suit "different classes of investments" more loosely but
  makes grouped reporting harder.
- Portfolio ordering in the list — user-defined sort order, or created-at? Only
  matters once a user has more than a handful.
