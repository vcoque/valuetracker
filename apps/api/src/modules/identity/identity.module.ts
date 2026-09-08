import { Module } from '@nestjs/common';

import { ConfigModule } from '../../shared/config/config.module';
import { PrismaModule } from '../../shared/prisma/prisma.module';
import { RateLimitGuard } from '../../shared/http/rate-limit.guard';
import { AuthGuard } from './auth.guard';
import { IdentityController } from './identity.controller';
import { IdentityService } from './identity.service';
import { TokenService } from './token.service';

/**
 * The `identity` capability module -- see `SPEC-identity.md`. It owns the
 * `user`, `user_credential` and `session` tables.
 *
 * Task 8 landed the schema and the pure hashing domain (`domain/password.ts`,
 * `domain/token.ts`). Task 9b added `POST /auth/register` and `POST /auth/login`.
 * Task 10 completes the surface: `/auth/refresh` (rotation + reuse detection),
 * `/auth/logout*`, `/auth/me`, `/auth/sessions`, and the public
 * `AuthGuard` / `CurrentUser` contract every other module consumes.
 *
 * `AuthGuard` is `exports`ed so a consumer module can `imports: [IdentityModule]`
 * then `@UseGuards(AuthGuard)`. `TokenService` is exported alongside it: Nest
 * instantiates a controller-scoped guard in the *consumer* module's injector,
 * so the guard's own dependency has to be visible there too. `CurrentUser` is a
 * param decorator -- not a DI provider -- consumed by import.
 *
 * The `domain/*` functions are imported directly, not registered as providers.
 */
@Module({
  imports: [PrismaModule, ConfigModule],
  controllers: [IdentityController],
  providers: [IdentityService, TokenService, RateLimitGuard, AuthGuard],
  exports: [AuthGuard, TokenService],
})
export class IdentityModule {}
