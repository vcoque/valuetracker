import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../../shared/prisma/prisma.service';
import {
  type InstrumentRow,
  type InstrumentStatus,
  type InstrumentTypeCode,
  type InstrumentView,
  mapInstrumentRow,
} from './domain/instrument';
import type { InstrumentSearchQuery } from './dto/instrument.dto';

/** Task 13's proven read pattern (ADR 0005, task-14-context.md). */
const INSTRUMENT_INCLUDE = {
  equity: true,
  etf: true,
  fixedIncome: true,
  crypto: true,
} satisfies Prisma.InstrumentInclude;

type InstrumentWithSpecializations = Prisma.InstrumentGetPayload<{
  include: typeof INSTRUMENT_INCLUDE;
}>;

/**
 * Read-only access to the `instrument` catalog (`SPEC-catalog.md` §API
 * Surface: `GET /instruments`, `GET /instruments/:id`). `POST`/`PATCH` are
 * Task 15 -- there is no write path here.
 *
 * Visibility is scoped **in the query** (`OR: [{ ownerUserId: null },
 * { ownerUserId: userId }]`), never fetch-then-filter (`SPEC.md` §Code
 * Style): a private instrument belonging to someone else must be
 * indistinguishable from one that doesn't exist, so both `search` and
 * `findVisibleById` apply the same ownership predicate before any row ever
 * reaches application code.
 */
@Injectable()
export class InstrumentService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * `GET /instruments`: public instruments union the caller's own private
   * ones, optionally narrowed by `type` (exact), `ticker` and `name`
   * (case-insensitive substring -- see `instrumentSearchQuerySchema`'s doc
   * comment in `@valuetracker/contract` for why).
   *
   * `ticker` matches `instrument_equity.ticker` or `instrument_etf.ticker`
   * only -- fixed income and crypto have no `ticker` field (crypto's natural
   * identifier is `symbol`, filtered separately if that need arises later).
   * This is a deliberate scoping decision, not an oversight: the ADR 0005
   * ETF/equity note is about the two specializations' *separate* partial
   * unique indexes, not a shared namespace, but a `ticker` search still
   * reasonably spans both since both use the same column name for the same
   * concept (an exchange-listed symbol).
   */
  async search(userId: string, query: InstrumentSearchQuery): Promise<InstrumentView[]> {
    const filters: Prisma.InstrumentWhereInput[] = [
      { OR: [{ ownerUserId: null }, { ownerUserId: userId }] },
    ];

    if (query.type !== undefined) {
      filters.push({ instrumentType: query.type });
    }
    if (query.name !== undefined) {
      filters.push({ name: { contains: query.name, mode: 'insensitive' } });
    }
    if (query.ticker !== undefined) {
      filters.push({
        OR: [
          { equity: { ticker: { contains: query.ticker, mode: 'insensitive' } } },
          { etf: { ticker: { contains: query.ticker, mode: 'insensitive' } } },
        ],
      });
    }

    const rows = await this.prisma.instrument.findMany({
      where: { AND: filters },
      include: INSTRUMENT_INCLUDE,
      orderBy: { name: 'asc' },
    });
    return rows.map((row) => mapInstrumentRow(toInstrumentRow(row)));
  }

  /**
   * `GET /instruments/:id`: one instrument, as a discriminated union. 404,
   * never 403, when the id belongs to another user's private instrument or
   * does not exist at all -- both are the same "not visible to you" outcome,
   * so instrument ids stay non-enumerable (`SPEC-catalog.md` AC, same rule
   * `portfolio.findOwnedById` follows).
   */
  async findVisibleById(userId: string, id: string): Promise<InstrumentView> {
    const row = await this.prisma.instrument.findFirst({
      where: { id, OR: [{ ownerUserId: null }, { ownerUserId: userId }] },
      include: INSTRUMENT_INCLUDE,
    });
    if (row === null) {
      throw new NotFoundException({ message: `Instrument ${id} not found` });
    }
    return mapInstrumentRow(toInstrumentRow(row));
  }
}

/**
 * The real Prisma row (base + `include`d relations) -> the domain's
 * {@link InstrumentRow}. `instrumentType` and `status` are cast, not
 * re-validated: both are FK/lookup-table-enforced at the database
 * (`instrument_type.code`, Task 13; `status` is free text in the schema but
 * every write path -- Task 15 -- will validate against
 * `instrumentStatusSchema`), so a row read back out of `instrument` is
 * trusted data, not user input. `domain/instrument.ts` stays free of any
 * `@prisma/client` import; this is the one boundary point that bridges the
 * two shapes.
 */
function toInstrumentRow(row: InstrumentWithSpecializations): InstrumentRow {
  return {
    ...row,
    instrumentType: row.instrumentType as InstrumentTypeCode,
    status: row.status as InstrumentStatus,
  };
}
