import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';

import { ZodValidationPipe } from '../../shared/http/zod-validation.pipe';
import { AuthGuard } from '../identity/auth.guard';
import { CurrentUser } from '../identity/current-user.decorator';
import {
  type CreatePortfolioRequest,
  createPortfolioRequestSchema,
  type PortfolioResponse,
} from './dto/portfolio.dto';
import { PortfolioService } from './portfolio.service';

/**
 * `SPEC-portfolio.md` §API Surface: create, list and get. `PATCH` and
 * archive/unarchive are Task 12. Every route is authenticated, and every
 * read/write is scoped to the caller's own rows in the query -- never checked
 * after fetching.
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
  list(@CurrentUser() userId: string): Promise<PortfolioResponse[]> {
    return this.portfolios.listActive(userId);
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
}
