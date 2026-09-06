import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';

/**
 * Jest runs globalSetup and globalTeardown in the same process but gives them no
 * channel between each other, so the container handle is parked on globalThis.
 * Declaring it here keeps that handoff typed instead of casting at both ends.
 */
declare global {
  // eslint-disable-next-line no-var -- `var` is what augments globalThis
  var __VALUETRACKER_PG_CONTAINER__: StartedPostgreSqlContainer | undefined;
}

export {};
