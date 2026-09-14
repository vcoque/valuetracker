import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';

import { ZodValidationPipe } from '../../shared/http/zod-validation.pipe';
import { AuthGuard } from '../identity/auth.guard';
import { CurrentUser } from '../identity/current-user.decorator';
import {
  type CreateFixedIncomeInstrumentRequest,
  createFixedIncomeInstrumentRequestSchema,
  type InstrumentResponse,
  type InstrumentSearchQuery,
  instrumentSearchQuerySchema,
  type UpdateFixedIncomeInstrumentRequest,
  updateFixedIncomeInstrumentRequestSchema,
} from './dto/instrument.dto';
import { InstrumentService } from './instrument.service';

/**
 * `SPEC-catalog.md` §API Surface: `GET /instruments` (search), `GET
 * /instruments/:id` (one, as a discriminated union), `POST /instruments`
 * (create a private FIXED_INCOME instrument, Task 15) and `PATCH
 * /instruments/:id` (update one the caller owns, Task 15). Every route is
 * `Auth: Yes`.
 *
 * `InstrumentService.search`/`findVisibleById`/`create`/`update` all return
 * `InstrumentView` (`domain/instrument.ts`), which is structurally the same
 * shape as `InstrumentResponse` (`@valuetracker/contract`) by construction --
 * the domain union is the source of truth for the fields, the contract
 * schema is the wire-validated mirror of them. `create`/`update` return the
 * full discriminated-union shape (not just the fixed-income fields) so a
 * client reads the same shape from `POST`/`PATCH` as it would from a
 * follow-up `GET /instruments/:id`.
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

  @Post()
  @HttpCode(HttpStatus.CREATED)
  create(
    @CurrentUser() userId: string,
    @Body(new ZodValidationPipe(createFixedIncomeInstrumentRequestSchema))
    body: CreateFixedIncomeInstrumentRequest,
  ): Promise<InstrumentResponse> {
    return this.instruments.create(userId, body);
  }

  @Patch(':id')
  update(
    @CurrentUser() userId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(updateFixedIncomeInstrumentRequestSchema))
    body: UpdateFixedIncomeInstrumentRequest,
  ): Promise<InstrumentResponse> {
    return this.instruments.update(userId, id, body);
  }
}
