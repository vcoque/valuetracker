# Spec: `identity`

Module `identity` from [`CAPABILITY-MAP.md`](./CAPABILITY-MAP.md). Depends on:
nothing. Project-wide stack, commands, structure, style, testing and boundaries
are defined once in [`SPEC.md`](./SPEC.md) and are not repeated here.

---

## Objective

Establish who the user is, so every other module can scope data to an owner.

`identity` owns the `user` entity and the session lifecycle. It is the first
module because every other module's authorisation story reduces to "which user
is this request for" — and because `portfolio` and `catalog` are meaningless
without it.

**Explicitly not in scope:** roles and permissions (there is exactly one role),
organisations or teams, SSO, password recovery via SMS, MFA. Assumption 2 in
`SPEC.md` says one owner per portfolio; this module encodes that and nothing more.

---

## Data Owned

`user`, exactly as specified in `ARCHITECTURE.md` §7.4, plus the credential and
session storage that the ER model deliberately excluded as an auth concern:

| Entity | Source | Notes |
|---|---|---|
| `user` | `ARCHITECTURE.md` §7.4 | `id`, `email` (unique), `display_name`, `base_currency_code`, `timezone`, timestamps |
| `user_credential` | New, this module | `user_id` (PK/FK), `password_hash`, `algorithm`, `updated_at` |
| `session` | New, this module | `id`, `user_id`, `expires_at`, `created_at`, `revoked_at`, `user_agent`, `ip` |

Splitting credentials from `user` keeps the hash out of every query that reads a
user, and makes it impossible to leak one by returning the other.

**This module adds three tables to `ARCHITECTURE.md` §7.** That is a data-model
change and falls under *Ask first* — the ER model must be updated to include
them before the migration is written.

---

## Decisions Required Before Implementation

Two open questions from `SPEC.md` block this module. Recommendations given;
confirm or overturn.

**Q3 — Session strategy. Recommendation: server-side sessions in an
httpOnly, Secure, SameSite=Lax cookie.** Assumption 3 says web-only, and cookie
sessions are revocable instantly by deleting a row, which JWTs are not without
adding the very session store JWTs were meant to avoid. Revocation matters more
than statelessness for a system holding a user's complete financial position.

**Q4 — Registration. Recommendation: open self-service registration with email
uniqueness, but no email verification in the first slice.** Verification needs
an email provider, which is a dependency the walking skeleton does not need to
prove the stack. Add it before any public deployment — tracked as a follow-up,
not silently dropped.

---

## API Surface

All responses are JSON. Session cookie is set on register and login, cleared on
logout.

| Method | Path | Purpose | Auth |
|---|---|---|---|
| `POST` | `/auth/register` | Create a user and open a session | No |
| `POST` | `/auth/login` | Authenticate and open a session | No |
| `POST` | `/auth/logout` | Revoke the current session | Yes |
| `GET` | `/auth/me` | Current user profile | Yes |
| `PATCH` | `/auth/me` | Update `display_name`, `base_currency_code`, `timezone` | Yes |

Consumed by other modules through an exported `CurrentUser` decorator and an
`AuthGuard`. No other module reads the `user` table directly — that is the
boundary rule in `SPEC.md`.

---

## Acceptance Criteria

- [ ] A user registers with email + password and receives a session cookie.
- [ ] Passwords are hashed with **argon2id** (or bcrypt with cost ≥ 12 if argon2 is unavailable). The hash never appears in any API response or log line.
- [ ] Email uniqueness is enforced by a **database unique constraint**, not only by an application check — proven by an integration test that attempts a duplicate insert directly.
- [ ] Login with a wrong password and login with an unknown email return the **same** error and take **indistinguishable** time. User enumeration through either channel is a defect.
- [ ] The session cookie is `httpOnly`, `Secure`, `SameSite=Lax`, with a fixed expiry.
- [ ] `POST /auth/logout` revokes the session such that reusing the cookie afterwards returns 401.
- [ ] An expired or revoked session returns 401, never 500.
- [ ] `AuthGuard` rejects requests with no session, an unknown session, or an expired one.
- [ ] `base_currency_code` is validated against the `currency` table and rejects unknown codes.
- [ ] Auth endpoints are rate-limited per IP.

## Verification

```
npm test -- --selectProjects unit                       # hashing, session expiry logic
npm test -- --selectProjects integration                # unique constraint, session revocation
npm run test:e2e -- identity                            # full register -> login -> me -> logout
```

Manual: register two users, confirm each `GET /auth/me` returns only its own
record, and confirm the second cannot reuse the first's session cookie.

## Open Questions

- Session lifetime and whether sliding expiry is wanted. Default proposed: 30-day
  absolute expiry, no sliding.
- Whether to store `user_agent` / `ip` on sessions at all — useful for a "sign
  out other devices" feature, but it is personal data with a retention cost.
- Password policy. Proposed: minimum 12 characters, no composition rules, checked
  against a common-password list.
