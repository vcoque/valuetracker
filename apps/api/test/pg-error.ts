/**
 * Expected shapes for PostgreSQL constraint violations as they surface through
 * `@prisma/adapter-pg`.
 *
 * A raw `$executeRawUnsafe` that trips a constraint rejects with a
 * `PrismaClientKnownRequestError` whose `meta.driverAdapterError.cause` carries
 * the driver's classification and the underlying SQLSTATE. The structural
 * invariants in each module spec are asserted against *these* codes, so the test
 * proves PostgreSQL rejected the write -- not merely that Prisma refused to try
 * (`SPEC.md` §Testing Strategy).
 *
 * Use with `expect(promise).rejects.toMatchObject(...)`.
 */

/** SQLSTATE 23505 -- a UNIQUE or PRIMARY KEY constraint was violated. */
export const uniqueViolation = {
  meta: {
    driverAdapterError: {
      cause: {
        kind: 'UniqueConstraintViolation',
        originalCode: '23505',
      },
    },
  },
} as const;

/** SQLSTATE 23503 -- a FOREIGN KEY constraint was violated. */
export const foreignKeyViolation = {
  meta: {
    driverAdapterError: {
      cause: {
        kind: 'ForeignKeyConstraintViolation',
        originalCode: '23503',
      },
    },
  },
} as const;
