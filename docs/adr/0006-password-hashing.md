# ADR 0006 — Password hashing uses `@node-rs/argon2`

- **Status:** Accepted
- **Date:** 2026-09-07
- **Amends:** `SPEC.md` §Tech Stack (adds a runtime dependency)
- **Implements:** `SPEC-identity.md` acceptance criterion "Passwords are hashed with argon2id"

## Context

`SPEC-identity.md` requires passwords to be stored with **argon2id** (bcrypt at
cost ≥ 12 is the sanctioned fallback), and `tasks/plan.md` Task 8 pre-authorises
adding the hashing library. `SPEC.md` §Boundaries still asks that the choice be
recorded, and §Tech Stack asks that any new pin be justified against evidence
rather than preference.

The obvious package is the bare [`argon2`](https://www.npmjs.com/package/argon2).
It builds its native addon at install time through `node-pre-gyp`: it downloads a
prebuilt binary when one matches and otherwise compiles via `node-gyp`, which
needs Python and a C++ toolchain. The project's entire premise is that the only
host dependency is Docker and the toolchain lives in the image
(`SPEC.md` §Tech Stack); a hashing library that can silently fall back to
compiling from source is a build-reliability risk in that container and in CI.
npm 11 also does not run dependency install scripts unless they are allow-listed,
so `argon2` would additionally need an `allowScripts` grant.

## Decision

Use **`@node-rs/argon2`, pinned to exactly `2.2.0`**.

It is a Rust (napi-rs) implementation shipped as **prebuilt platform binaries**
selected through `optionalDependencies` — `@node-rs/argon2-linux-x64-gnu` for the
`node:24-bookworm-slim` toolchain image. There is **no install script** and no
compile step, so it needs no `allowScripts` entry and cannot degrade to a
source build. It was verified to load and hash/verify inside the container.

Parameters (argon2id, the OWASP Password Storage Cheat Sheet minimum, which are
also the library's defaults, pinned explicitly in `domain/password.ts` so a
change to the library default cannot move the security bar):

| Parameter | Value |
|---|---|
| Algorithm | argon2id |
| Memory cost | 19456 KiB (19 MiB) |
| Time cost (passes) | 2 |
| Parallelism | 1 |

The encoded PHC hash embeds these, so verification needs no matching config, and
`user_credential.algorithm` records `argon2id` alongside each hash so stored
hashes can be re-hashed in place when these parameters are raised.

The refresh token is **not** hashed with argon2id — it is 256 bits of server
randomness and gets a plain SHA-256, see ADR 0003.

## Consequences

- One runtime dependency added: `@node-rs/argon2@2.2.0`. It brings one
  platform-specific optional dependency at install time and no transitive
  runtime dependencies. It adds no entries to `npm audit`.
- The hashing code stays pure domain code with a single import; no Nest
  provider, no I/O.
- If a future target platform has no prebuilt binary in this package, the
  fallback is bcrypt at cost ≥ 12 as `SPEC-identity.md` already sanctions, which
  would be its own ADR.

## Alternatives considered

**Bare `argon2`.** Same algorithm, mature, widely used. Rejected for this
project because its install-time `node-pre-gyp` step can fall back to a
from-source compile that the slim container is not provisioned for, and it
requires an `allowScripts` grant under npm 11.

**bcrypt at cost ≥ 12.** The spec's explicit fallback. Not needed: the argon2
path builds and runs. bcrypt also caps the effective password length at 72
bytes, which argon2id does not.
