# ADR 0001 — Monorepo with npm workspaces

- **Status:** Accepted
- **Date:** 2026-09-06
- **Supersedes:** the single-application layout in `SPEC.md` §Project Structure

## Context

ValueTracker is planned as a NestJS API, a web frontend, and later a native
Android application. All three consume the same HTTP contract, and two of them
are TypeScript.

Task 2 of [`tasks/plan.md`](../../tasks/plan.md) scaffolds the NestJS
application. Where that lands is effectively permanent: moving it afterwards
touches every path in `SPEC.md`, all three Jest project configurations, the
`tsconfig` path mappings and the container's working directory. The decision
therefore has to be made before Task 2, not after.

The alternative to deciding is drift: the web client hand-maintaining a copy of
the API's request and response types, and the Android client later maintaining a
third. Type copies do not fail loudly when they diverge — they fail at runtime,
in production, on data the tests did not cover.

## Decision

A single repository, organised as npm workspaces:

```
apps/
  api/         NestJS + Prisma; owns prisma/ and test/e2e/
  web/         Web frontend
  mobile/      Native Android; created when work on it starts, not before
packages/
  contract/    zod schemas and the types inferred from them
```

`packages/contract` is the load-bearing piece and the only one that justifies
the monorepo on its own. The API validates with those schemas; clients infer
their types from the same source. There is one definition, not three copies.

npm workspaces rather than Nx or Turborepo. npm 11 is already in the toolchain
image, workspaces need no additional tooling, and Turborepo can be added later
purely for task caching without moving a file. Nx would impose a generator and
plugin model on a NestJS + Prisma setup that `SPEC.md` already specifies in
detail.

## Consequences

- Task 2 scaffolds into `apps/api`, not the repository root. `SPEC.md`
  §Project Structure is rewritten accordingly.
- `compose-dev.yaml` gains a `web` service beside `api`. The toolchain image is
  unchanged: one Node serves every workspace.
- `apps/mobile` will **not** run in the container toolchain. Metro and an Android
  emulator are host-native, so mobile development reintroduces a host Node
  requirement. This is what `.nvmrc` is retained for.
- A change to a shared schema can break two applications at once. That is the
  intended behaviour — it breaks at compile time rather than in production.

## Alternatives considered

**Separate repositories per application.** Rejected: the contract would have to
be versioned and published as a package across repositories, and every contract
change would become a multi-repository release. That cost is only worth paying
when teams need to release independently, which does not apply here.

**Single application, web served by NestJS.** Rejected: it couples the web
build to the API deployment and offers the Android client nothing.

**Nx or Turborepo from the start.** Deferred, not rejected. Neither solves a
problem this repository has yet, and both can be adopted later without
restructuring.
