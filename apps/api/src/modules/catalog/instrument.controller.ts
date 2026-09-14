import { Controller, Get, Param, ParseUUIDPipe, Query, UseGuards } from '@nestjs/common';

import { ZodValidationPipe } from '../../shared/http/zod-validation.pipe';
import { AuthGuard } from '../identity/auth.guard';
import { CurrentUser } from '../identity/current-user.decorator';
import {
  type InstrumentResponse,
  type InstrumentSearchQuery,
  instrumentSearchQuerySchema,
} from './dto/instrument.dto';
import { InstrumentService } from './instrument.service';

/**
 * `SPEC-catalog.md` §API Surface: `GET /instruments` (search) and `GET
 * /instruments/:id` (one, as a discriminated union). Both routes are `Auth:
 * Yes`. `POST`/`PATCH /instruments` are Task 15 -- not in this controller.
 *
 * `InstrumentService.search`/`findVisibleById` return `InstrumentView`
 * (`domain/instrument.ts`), which is structurally the same shape as
 * `InstrumentResponse` (`@valuetracker/contract`) by construction -- the
 * domain union is the source of truth for the fields, the contract schema is
 * the wire-validated mirror of them.
 */
@Controller('instruments')
@UseGuards(AuthGuard)
export class InstrumentController {
  constructor(private readonly instruments: InstrumentService) {}

  @Get()
  search(
    @CurrentUser() userId: string,
    @Query(new ZodValidationPipe(instrumentSearchQuerySchema))
    query: InstrumentSearchQuery,
  ): Promise<InstrumentResponse[]> {
    return this.instruments.search(userId, query);
  }

  @Get(':id')
  findById(
    @CurrentUser() userId: string,
    // A malformed id is a 400, not a 500 from a raw "invalid input syntax
    // for type uuid" at the database -- same reasoning as
    // `portfolio.controller.ts`. A well-formed id belonging to someone else
    // still falls through to the service's ownership-scoped 404.
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<InstrumentResponse> {
    return this.instruments.findVisibleById(userId, id);
  }
}
