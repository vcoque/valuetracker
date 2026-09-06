// ValueTracker lint configuration -- one flat config for every workspace.
//
// The two rules this project actually depends on are no-explicit-any and
// no-floating-promises. Both are type-aware, which is why the config uses
// `recommendedTypeChecked` and the TypeScript project service rather than the
// cheaper syntactic preset: a floating promise cannot be detected without types,
// and in an async NestJS + Prisma codebase an unawaited write is a data bug that
// no test reliably catches.

import eslint from '@eslint/js';
import prettier from 'eslint-config-prettier';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/coverage/**',
      '**/node_modules/**',
      '**/*.js',
      '**/*.d.ts',
    ],
  },

  eslint.configs.recommended,
  tseslint.configs.recommendedTypeChecked,

  {
    languageOptions: {
      parserOptions: {
        // Reads each file's owning tsconfig, so lint and typecheck agree on
        // what the types are. allowDefaultProject covers the root-level config
        // files, which belong to no workspace tsconfig.
        projectService: {
          allowDefaultProject: ['eslint.config.mjs', 'jest.config.ts'],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // SPEC.md §Boundaries: `any` erases the guarantees the strict compiler
      // settings buy, and it spreads -- one `any` at a boundary silently
      // untypes everything downstream of it.
      '@typescript-eslint/no-explicit-any': 'error',

      // An unawaited promise in a request handler resolves after the response
      // is sent, so its rejection surfaces as an unhandled rejection with no
      // request context attached -- if it surfaces at all.
      '@typescript-eslint/no-floating-promises': 'error',

      // Same failure, one level up: an async function passed where a
      // void-returning callback is expected has nobody to await it.
      '@typescript-eslint/no-misused-promises': 'error',

      // Unused code is either a mistake or a leftover. `_`-prefixed arguments
      // stay legal, since an interface sometimes forces a parameter you do not
      // need.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],

      // SPEC.md §Boundaries requires configuration to arrive through the
      // zod-validated typed config, never from a raw environment read. Stated as
      // a convention this decays the first time someone needs a value in a
      // hurry; stated as a lint error it does not. `src/shared/config` is the
      // one sanctioned reader in application code and opts out on a single
      // annotated line, so the exception is visible in review.
      'no-restricted-properties': [
        'error',
        {
          object: 'process',
          property: 'env',
          message:
            'Read configuration through AppConfig (src/shared/config) instead ' +
            'of process.env, so a missing value fails at startup and names itself.',
        },
      ],
    },
  },

  // The test harness is environment plumbing by definition -- starting a
  // throwaway database and repointing DATABASE_URL at it is its entire job, and
  // it runs before any application code exists to ask. Banning the read here
  // would mean an escape hatch on every second line, which trains people to
  // reach for the escape hatch. The ban stays absolute where it means something:
  // application code under src/.
  {
    files: ['apps/*/test/**/*.ts'],
    rules: {
      'no-restricted-properties': 'off',
    },
  },

  // The root tooling configs belong to no workspace tsconfig, so the type-aware
  // rules have no real types to work with and report phantom `error`-typed
  // values. They are still linted, just syntactically.
  {
    files: ['eslint.config.mjs', 'jest.config.ts'],
    extends: [tseslint.configs.disableTypeChecked],
  },

  // Prettier last: it turns off the stylistic rules that would otherwise fight
  // the formatter. It adds no rules of its own.
  prettier,
);
