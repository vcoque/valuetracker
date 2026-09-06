// ValueTracker test configuration.
//
// Three selectable Jest projects rather than one suite, so the fast feedback
// loop stays fast. `unit` touches no I/O and runs in about a second; the other
// two need Docker and take orders of magnitude longer, and nobody will run a
// suite on every save if the two are welded together.
//
//   npm test                              every project
//   npm test -- --selectProjects unit     the fast one
//   npm run test:e2e                      HTTP through a real database
//
// The three are distinguished by filename, not by directory, so a module's
// tests live next to the code they test:
//
//   src/**/*.spec.ts       unit         pure logic, no I/O
//   src/**/*.int-spec.ts   integration  real PostgreSQL via Testcontainers
//   test/e2e/*.e2e-spec.ts e2e          full HTTP stack

import type { Config } from 'jest';

/**
 * ts-jest compiles each test in isolation, so it needs the same compiler
 * options the build uses -- decorator metadata above all, without which every
 * Nest dependency injects as undefined.
 */
const transform: Config['transform'] = {
  '^.+\\.ts$': [
    'ts-jest',
    {
      tsconfig: '<rootDir>/apps/api/tsconfig.json',
      diagnostics: {
        // TS151002 advises turning on isolatedModules under a hybrid module
        // kind. Taking that advice breaks emitDecoratorMetadata: a per-file
        // compile cannot tell a type from a value, so every injected
        // dependency is emitted as an unreachable typeof guard falling back to
        // `Object`. Whole-program compilation is slower and correct, which is
        // the right trade for a suite this size. See apps/api/tsconfig.json.
        ignoreCodes: [151002],
      },
    },
  ],
};

const config: Config = {
  rootDir: '.',

  projects: [
    {
      displayName: 'unit',
      rootDir: '.',
      testEnvironment: 'node',
      // `*.int-spec.ts` deliberately does not match this pattern: it ends in
      // `-spec.ts`, not `.spec.ts`.
      testMatch: ['<rootDir>/apps/*/src/**/*.spec.ts'],
      transform,
    },
    {
      displayName: 'integration',
      rootDir: '.',
      testEnvironment: 'node',
      testMatch: ['<rootDir>/apps/*/src/**/*.int-spec.ts'],
      transform,
      globalSetup: '<rootDir>/apps/api/test/global-setup.ts',
      globalTeardown: '<rootDir>/apps/api/test/global-teardown.ts',
      setupFilesAfterEnv: ['<rootDir>/apps/api/test/integration-setup.ts'],
      // Testcontainers has to pull and start a PostgreSQL image per run.
      testTimeout: 60_000,
    },
    {
      displayName: 'e2e',
      rootDir: '.',
      testEnvironment: 'node',
      testMatch: ['<rootDir>/apps/*/test/e2e/**/*.e2e-spec.ts'],
      transform,
      // e2e runs against the same throwaway server and the same clean-slate
      // rule: AppModule now owns a database connection, so "full HTTP stack"
      // includes the stack reaching Postgres. Naming the same hook files as the
      // integration project above is intentional -- Jest keys global hooks by
      // module path, so both projects share one container.
      globalSetup: '<rootDir>/apps/api/test/global-setup.ts',
      globalTeardown: '<rootDir>/apps/api/test/global-teardown.ts',
      setupFilesAfterEnv: ['<rootDir>/apps/api/test/integration-setup.ts'],
      testTimeout: 60_000,
    },
  ],

  // Coverage is measured across every project at once, because a line covered
  // by an e2e test is covered. Measuring per project would push the suite
  // toward unit tests written only to move the number.
  collectCoverageFrom: [
    'apps/*/src/**/*.ts',
    '!apps/*/src/**/*.spec.ts',
    '!apps/*/src/**/*.int-spec.ts',
    // The bootstrap file: it opens a listening socket and is exercised by
    // running the process, not by importing it. Nothing else is excluded --
    // modules and controllers stay in the denominator.
    '!apps/*/src/main.ts',
  ],
  coverageDirectory: '<rootDir>/coverage',
  coverageThreshold: {
    global: {
      branches: 80,
      functions: 80,
      lines: 80,
      statements: 80,
    },
  },
};

export default config;
