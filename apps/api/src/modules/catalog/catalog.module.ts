import { Module } from '@nestjs/common';

import { PrismaModule } from '../../shared/prisma/prisma.module';
import { IdentityModule } from '../identity/identity.module';
import { InstrumentController } from './instrument.controller';
import { InstrumentService } from './instrument.service';
import { ReferenceController } from './reference.controller';
import { ReferenceService } from './reference.service';

/**
 * The `catalog` capability module -- see `SPEC-catalog.md`. Phase 0 gave it
 * only the seeded reference data (`GET /currencies`, `GET /exchanges`); Task
 * 13 added the `instrument` class-table hierarchy (schema + constraints
 * only); Task 14 adds its read model -- `GET /instruments` (search) and `GET
 * /instruments/:id` (discriminated union). `POST`/`PATCH /instruments` are
 * Task 15.
 *
 * `IdentityModule` is imported for `AuthGuard`: every route in this module is
 * "Auth: Yes" (Ruling S4).
 */
@Module({
  imports: [PrismaModule, IdentityModule],
  controllers: [ReferenceController, InstrumentController],
  providers: [ReferenceService, InstrumentService],
})
export class CatalogModule {}
