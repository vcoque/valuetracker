import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, type Portfolio } from '@prisma/client';

import { PrismaService } from '../../shared/prisma/prisma.service';
import type {
  CreatePortfolioRequest,
  PortfolioResponse,
  UpdatePortfolioRequest,
} from './dto/portfolio.dto';

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

  /**
   * The caller's portfolios, active by default. `includeArchived` drops the
   * `archivedAt: null` filter (`SPEC-portfolio.md`: "`?includeArchived=true`
   * on the list endpoint returns archived portfolios too").
   */
  async list(userId: string, includeArchived = false): Promise<PortfolioResponse[]> {
    const portfolios = await this.prisma.portfolio.findMany({
      where: includeArchived ? { userId } : { userId, archivedAt: null },
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
   *
   * Deliberately does NOT filter `archivedAt` (Task 12 design decision --
   * `SPEC-portfolio.md` never says the single-get should hide archived rows,
   * only that the *list* default-hides them). This keeps `GET /portfolios/:id`
   * consistent with the list's `?includeArchived=true`, and lets `update`,
   * `archive` and `unarchive` all share this one lookup rather than needing a
   * second "any status" variant to find something they're about to unarchive.
   */
  async findOwnedById(userId: string, id: string): Promise<PortfolioResponse> {
    const portfolio = await this.prisma.portfolio.findFirst({
      where: { id, userId },
    });
    if (portfolio === null) {
      throw new NotFoundException({ message: `Portfolio ${id} not found` });
    }
    return toResponse(portfolio);
  }

  /**
   * Updates `name`, `description`, `objective`, `target_amount`,
   * `target_date` (`SPEC-portfolio.md` §API Surface). `base_currency_code`
   * and `user_id` are not accepted by `updatePortfolioRequestSchema` at all
   * (`.strict()`), so an attempt to change either is already a 400 by the
   * time this method runs -- see the schema's doc comment in
   * `@valuetracker/contract`.
   *
   * The write itself is scoped by `{ id, userId }` (`updateMany`, not
   * `update`, so ownership is enforced by the query rather than by a
   * find-then-trust step); `count === 0` means no row matched -- either the
   * id doesn't exist or it belongs to someone else, and both are a 404.
   */
  async update(
    userId: string,
    id: string,
    patch: UpdatePortfolioRequest,
  ): Promise<PortfolioResponse> {
    try {
      const result = await this.prisma.portfolio.updateMany({
        where: { id, userId },
        data: {
          ...(patch.name !== undefined && { name: patch.name }),
          ...(patch.description !== undefined && {
            description: patch.description,
          }),
          ...(patch.objective !== undefined && { objective: patch.objective }),
          ...(patch.targetAmount !== undefined && {
            targetAmount:
              patch.targetAmount !== null
                ? new Prisma.Decimal(patch.targetAmount)
                : null,
          }),
          ...(patch.targetDate !== undefined && {
            targetDate:
              patch.targetDate !== null ? new Date(patch.targetDate) : null,
          }),
        },
      });
      if (result.count === 0) {
        throw new NotFoundException({ message: `Portfolio ${id} not found` });
      }
    } catch (error) {
      // (user_id, name) is unique -- renaming into a name the caller already
      // owns loses at the database, same mapping as `create`.
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new ConflictException({ message: DUPLICATE_NAME_MESSAGE });
      }
      throw error;
    }
    return this.findOwnedById(userId, id);
  }

  /**
   * Archive: sets `archived_at = now()` without deleting the row
   * (`SPEC-portfolio.md`: "Portfolios are archived, never deleted"). Scoped by
   * `{ id, userId }` the same way `update` is.
   */
  async archive(userId: string, id: string): Promise<PortfolioResponse> {
    const result = await this.prisma.portfolio.updateMany({
      where: { id, userId },
      data: { archivedAt: new Date() },
    });
    if (result.count === 0) {
      throw new NotFoundException({ message: `Portfolio ${id} not found` });
    }
    return this.findOwnedById(userId, id);
  }

  /** Unarchive: sets `archived_at = null`, restoring it to the default list. */
  async unarchive(userId: string, id: string): Promise<PortfolioResponse> {
    const result = await this.prisma.portfolio.updateMany({
      where: { id, userId },
      data: { archivedAt: null },
    });
    if (result.count === 0) {
      throw new NotFoundException({ message: `Portfolio ${id} not found` });
    }
    return this.findOwnedById(userId, id);
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
