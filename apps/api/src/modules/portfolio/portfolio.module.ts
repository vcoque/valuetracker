import { Module } from '@nestjs/common';

import { PrismaModule } from '../../shared/prisma/prisma.module';
import { IdentityModule } from '../identity/identity.module';
import { PortfolioController } from './portfolio.controller';
import { PortfolioService } from './portfolio.service';

/**
 * The `portfolio` capability module -- see `SPEC-portfolio.md`. Owns the
 * portfolio row and its ownership rules, and nothing else: positions belong
 * to `ledger`.
 *
 * `IdentityModule` is imported for `AuthGuard` -- every route in this module
 * is authenticated. `PortfolioService` is exported so a future `ledger`
 * module can consume `findOwnedById` rather than querying `portfolio`
 * directly (`SPEC-portfolio.md` §API Surface).
 */
@Module({
  imports: [PrismaModule, IdentityModule],
  controllers: [PortfolioController],
  providers: [PortfolioService],
  exports: [PortfolioService],
})
export class PortfolioModule {}
