/**
 * Stops the throwaway database started by `global-setup.ts`.
 *
 * Testcontainers also runs a reaper that would eventually remove an orphaned
 * container, but only eventually. Stopping it here keeps a developer's machine
 * from accumulating one abandoned PostgreSQL per interrupted test run.
 */
export default async function globalTeardown(): Promise<void> {
  await globalThis.__VALUETRACKER_PG_CONTAINER__?.stop();
  globalThis.__VALUETRACKER_PG_CONTAINER__ = undefined;
}
