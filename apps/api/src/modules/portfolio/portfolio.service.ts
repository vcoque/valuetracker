import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, type Portfolio } from '@prisma/client';

import { PrismaService } from '../../shared/prisma/prisma.service';
import type { CreatePortfolioRequest, PortfolioResponse } from './dto/portfolio.dto';

const UNKNOWN_CURRENCY_MESSAGE =
  'base_currency_code does not match a known currency';
const DUPLICATE_NAME_MESSAGE = 'a portfolio with this name already exists';

/**
 * Owns the `portfolio` row and its ownership rules (`SPEC-portfolio.md`
 * §Objective). Positions/holdings belong to `ledger`, out of scope here.
 *
 * Every read and write is scoped by `userId` **in the `where` clause**, never
 * checked after fetching (`SPEC.md` §Code Style) -- a portfolio belonging to
 * another user must be indistinguishable from one that doesn't exist.
 */
@Injectable()
export class PortfolioService {
  constructor(private readonly prisma: PrismaService) {}

  async create(
    userId: string,
    input: CreatePortfolioRequest,
  ): Promise<PortfolioResponse> {
    try {
      const portfolio = await this.prisma.portfolio.create({
        data: {
          userId,
          name: input.name,
          description: input.description ?? null,
          objective: input.objective ?? null,
          baseCurrencyCode: input.baseCurrencyCode,
          targetAmount:
            input.targetAmount != null
              ? new Prisma.Decimal(input.targetAmount)
              : null,
          targetDate:
            input.targetDate != null ? new Date(input.targetDate) : null,
        },
      });
      return toResponse(portfolio);
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError) {
        // (user_id, name) is unique (SPEC-portfolio.md AC) -- a race between
        // two requests for the same name loses at the database, not the API.
        if (error.code === 'P2002') {
          throw new ConflictException({ message: DUPLICATE_NAME_MESSAGE });
        }
        // The only foreign key a client controls here is `base_currency_code`
        // -> `currency.code`; the wire schema accepts any AAA..ZZZ but only
        // seeded codes exist. SPEC-portfolio.md: "base_currency_code is
        // FK-validated against currency and rejects unknown codes."
        if (
          error.code === 'P2003' &&
          JSON.stringify(error.meta ?? {}).includes('base_currency_code')
        ) {
          throw new BadRequestException({ message: UNKNOWN_CURRENCY_MESSAGE });
        }
      }
      throw error;
    }
  }

  /** The caller's active (non-archived) portfolios. */
  async listActive(userId: string): Promise<PortfolioResponse[]> {
    const portfolios = await this.prisma.portfolio.findMany({
      where: { userId, archivedAt: null },
      orderBy: { createdAt: 'asc' },
    });
    return portfolios.map(toResponse);
  }

  /**
   * One portfolio the caller owns. Exported for `ledger` to consume
   * (`SPEC-portfolio.md` §API Surface) -- `ledger` never queries the
   * `portfolio` table directly.
   *
   * Ownership is scoped IN the query (`where: { id, userId }`), never checked
   * after fetching: a portfolio that exists but belongs to another user is
   * 404, not 403 -- portfolio ids must not be enumerable.
   */
  async findOwnedById(userId: string, id: string): Promise<PortfolioResponse> {
    const portfolio = await this.prisma.portfolio.findFirst({
      where: { id, userId, archivedAt: null },
    });
    if (portfolio === null) {
      throw new NotFoundException({ message: `Portfolio ${id} not found` });
    }
    return toResponse(portfolio);
  }
}

/** `Portfolio` (Prisma row, `Decimal`/`Date`) -> the wire shape (strings). */
function toResponse(portfolio: Portfolio): PortfolioResponse {
  return {
    id: portfolio.id,
    name: portfolio.name,
    description: portfolio.description,
    objective: portfolio.objective,
    baseCurrencyCode: portfolio.baseCurrencyCode,
    targetAmount:
      portfolio.targetAmount !== null ? portfolio.targetAmount.toFixed(4) : null,
    targetDate:
      portfolio.targetDate !== null
        ? portfolio.targetDate.toISOString().slice(0, 10)
        : null,
    createdAt: portfolio.createdAt.toISOString(),
  };
}
