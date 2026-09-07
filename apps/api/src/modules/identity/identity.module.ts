import { Module } from '@nestjs/common';

import { PrismaModule } from '../../shared/prisma/prisma.module';

/**
 * The `identity` capability module -- see `SPEC-identity.md`. It owns the
 * `user`, `user_credential` and `session` tables.
 *
 * Task 8 lands only the schema and the pure hashing domain
 * (`domain/password.ts`, `domain/token.ts`), which are plain functions imported
 * directly rather than Nest providers. The auth service, `AuthGuard`,
 * `CurrentUser` decorator and the `/auth/*` controllers arrive in Tasks 9-10;
 * they will register here. `PrismaModule` is imported now so that wiring is a
 * one-line addition then rather than a module-graph change.
 */
@Module({
  imports: [PrismaModule],
})
export class IdentityModule {}
