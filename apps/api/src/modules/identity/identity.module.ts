import { Module } from '@nestjs/common';

import { ConfigModule } from '../../shared/config/config.module';
import { PrismaModule } from '../../shared/prisma/prisma.module';
import { RateLimitGuard } from '../../shared/http/rate-limit.guard';
import { IdentityController } from './identity.controller';
import { IdentityService } from './identity.service';
import { TokenService } from './token.service';

/**
 * The `identity` capability module -- see `SPEC-identity.md`. It owns the
 * `user`, `user_credential` and `session` tables.
 *
 * Task 8 landed the schema and the pure hashing domain (`domain/password.ts`,
 * `domain/token.ts`). Task 9b adds `POST /auth/register` and `POST /auth/login`:
 * the `IdentityService`, the EdDSA `TokenService` (signing key + `kid`), and the
 * per-IP `RateLimitGuard` scoped to this controller. `/auth/refresh`,
 * `/auth/logout*`, `AuthGuard` and `CurrentUser` arrive in Task 10.
 *
 * The `domain/*` functions are imported directly, not registered as providers.
 */
@Module({
  imports: [PrismaModule, ConfigModule],
  controllers: [IdentityController],
  providers: [IdentityService, TokenService, RateLimitGuard],
})
export class IdentityModule {}
