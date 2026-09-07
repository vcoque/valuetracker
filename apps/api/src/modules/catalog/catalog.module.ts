import { Module } from '@nestjs/common';

import { PrismaModule } from '../../shared/prisma/prisma.module';
import { ReferenceController } from './reference.controller';
import { ReferenceService } from './reference.service';

/**
 * The `catalog` capability module -- see `SPEC-catalog.md`. Phase 0 gives it
 * only the seeded reference data (`GET /currencies`, `GET /exchanges`); Task 13
 * extends this same module with the `instrument` tables and their endpoints.
 */
@Module({
  imports: [PrismaModule],
  controllers: [ReferenceController],
  providers: [ReferenceService],
})
export class CatalogModule {}
