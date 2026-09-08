# ADR 0003 — JWT access tokens with server-side refresh sessions

- **Status:** Accepted
- **Date:** 2026-09-06
- **Supersedes:** the cookie-session recommendation in `SPEC-identity.md`
- **Resolves:** `SPEC.md` open questions 3 and 4

## Context

`SPEC.md` open question 3 asked: cookie sessions or JWT. The original
recommendation was server-side sessions in an httpOnly cookie, on the stated
assumption that ValueTracker is web-only.

[ADR 0002](./0002-native-android-app-not-webview.md) invalidates that
assumption. A native Android client has no browser cookie jar, so a
cookie-only design would need a second, parallel mechanism bolted on later —
precisely the migration this decision is meant to avoid. OIDC is also a stated
future requirement.

A single long-lived stateless JWT is the one option that is *less* safe than the
cookie session it would replace: it cannot be withdrawn before it expires, so
logout, "sign out all devices" and a stolen phone all degrade to "wait for the
token to lapse". For a system holding a user's complete financial position, that
is not acceptable.

## Decision

Issue a **pair**:

- **Access token** — a JWT, 15-minute lifetime, signed with EdDSA (Ed25519) and
  a `kid` header. Claims are `sub`, `sid`, `iat`, `exp`, `iss`, `aud` and nothing
  else. Stateless: no database round-trip to authorise a request.
- **Refresh token** — 30 days absolute, opaque, 256 bits of server-generated
  randomness, stored **only as a SHA-256 hash** in the `session` table. Rotated
  on every use, with reuse detection revoking the whole chain.

Transport varies by client; the model does not. Web receives the refresh token
in an httpOnly, Secure, SameSite=Strict cookie path-scoped to `/auth/refresh`,
and holds the access token in memory only. Android stores both in the Keystore.

Registration is **open self-service signup** with email and password.
Multi-user from the start. Email verification is deferred out of the first
slice; per-IP rate limiting on the auth endpoints is not.

## Consequences

- Revocation is real and near-immediate: revoking a session invalidates the
  refresh token at once and the access token within 15 minutes.
- The API scales horizontally without shared session state, since the common path
  verifies a signature rather than reading a row.
- This is the same token shape an OIDC provider issues, so adding OIDC later
  slots into the existing flow instead of replacing it.
- The `session` table gains `token_hash`, `client_type` and `replaced_by_id`, and
  loses nothing. It is a refresh-token store, one row per logged-in device, which
  is exactly what a "signed-in devices" screen needs.
- Asymmetric signing means anything verifying a token needs only the public key.
  Key rotation is possible without invalidating live tokens, via `kid`.
- **Cost:** more moving parts than a session cookie — a refresh endpoint, a
  rotation chain, reuse detection, and key management. Each is covered by an
  acceptance criterion in `SPEC-identity.md` rather than left to judgement.

## Reuse detection: strictness vs. client retries

Any replay of an **already-rotated** refresh token currently revokes **every
live session for that user** — `SPEC-identity.md`'s "revokes the entire chain
for that user", implemented in `IdentityService.refresh`. This is correct when
the replay is genuine theft, but it does not distinguish a benign
double-submit: if a client fires two parallel refreshes, or completes a refresh
whose response is lost on a flaky mobile network and retries with the same
token, the second request lands on the "already rotated" branch and logs the
user out on **all** devices. Flaky networks do this routinely.

The standard mitigation is an **Auth0-style grace window**: if the presented
token was rotated very recently (say, younger than ~10 s) and its immediate
successor is still live and un-rotated, treat the replay as a retry — return a
plain 401 for that request without revoking the chain. Genuine theft, where the
attacker races the legitimate client, still trips detection because the
successor will already have been rotated or the window will have elapsed.

This is **deferred pending an owner decision** and is deliberately **not
implemented** in the walking skeleton. Until it is, the guidance to clients is:
never fire refreshes in parallel, and treat a failed refresh as "re-login",
not "retry".

## Alternatives considered

**Server-side opaque sessions in a cookie.** The original recommendation, and
still the simplest correct answer for a web-only product. Rejected because the
Android client would need a second mechanism.

**Long-lived stateless JWT with no refresh token.** Rejected: unrevocable. A
denylist to make it revocable would reintroduce the very session store the
design was meant to remove, while keeping the worse failure mode.

**HS256 instead of EdDSA.** Defensible while this is a single service, and
simpler. Rejected because it is cheap now and expensive to reverse: every
verifier needs the signing secret.

**Storing the refresh token with argon2id rather than SHA-256.** Rejected. The
token is 256 bits of server-generated randomness, so it is not brute-forcible,
and a deliberately slow hash would add latency to every refresh for no gain.
Passwords are low-entropy and human-chosen, which is why they do get argon2id.
