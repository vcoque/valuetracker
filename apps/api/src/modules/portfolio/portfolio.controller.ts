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
  type CreatePortfolioRequest,
  createPortfolioRequestSchema,
  type PortfolioResponse,
  type UpdatePortfolioRequest,
  updatePortfolioRequestSchema,
} from './dto/portfolio.dto';
import { PortfolioService } from './portfolio.service';

/**
 * `SPEC-portfolio.md` §API Surface: create, list, get, update, archive and
 * unarchive. There is deliberately no `DELETE` -- archive is the only removal
 * path. Every route is authenticated, and every read/write is scoped to the
 * caller's own rows in the query -- never checked after fetching.
 */
@Controller('portfolios')
@UseGuards(AuthGuard)
export class PortfolioController {
  constructor(private readonly portfolios: PortfolioService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  create(
    @CurrentUser() userId: string,
    @Body(new ZodValidationPipe(createPortfolioRequestSchema))
    body: CreatePortfolioRequest,
  ): Promise<PortfolioResponse> {
    return this.portfolios.create(userId, body);
  }

  @Get()
  list(
    @CurrentUser() userId: string,
    // A bare `?includeArchived=true` flag, not a zod-validated body -- any
    // other value (missing, "false", "1", ...) means "active only", which is
    // the safe default (`SPEC-portfolio.md`: default list excludes archived).
    @Query('includeArchived') includeArchived?: string,
  ): Promise<PortfolioResponse[]> {
    return this.portfolios.list(userId, includeArchived === 'true');
  }

  @Get(':id')
  get(
    @CurrentUser() userId: string,
    // ParseUUIDPipe turns a malformed id into a 400 rather than a 500 from a
    // raw "invalid input syntax for type uuid" at the database. A well-formed
    // id that belongs to someone else still falls through to the service's
    // ownership-scoped 404.
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<PortfolioResponse> {
    return this.portfolios.findOwnedById(userId, id);
  }

  @Patch(':id')
  update(
    @CurrentUser() userId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(updatePortfolioRequestSchema))
    body: UpdatePortfolioRequest,
  ): Promise<PortfolioResponse> {
    return this.portfolios.update(userId, id, body);
  }

  @Post(':id/archive')
  @HttpCode(HttpStatus.OK)
  archive(
    @CurrentUser() userId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<PortfolioResponse> {
    return this.portfolios.archive(userId, id);
  }

  @Post(':id/unarchive')
  @HttpCode(HttpStatus.OK)
  unarchive(
    @CurrentUser() userId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<PortfolioResponse> {
    return this.portfolios.unarchive(userId, id);
  }
}
