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
import { type InstrumentSearchQuery, instrumentStatusSchema } from './dto/instrument.dto';

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
 * {@link InstrumentRow}. `domain/instrument.ts` stays free of any
 * `@prisma/client` import; this is the one boundary point that bridges the
 * two shapes.
 *
 * `instrumentType` is cast, not re-validated: it is FK-enforced at the
 * database against `instrument_type.code` (Task 13), so a row read back out
 * of `instrument` already carries a value from the closed set --
 * `InstrumentTypeCode` and the FK's domain are the same set by construction.
 *
 * `status`, unlike `instrumentType`, has **no** database-level constraint --
 * the Task 13 migration declares it `VARCHAR(16) NOT NULL` only, with no
 * CHECK or FK pinning it to `instrumentStatusSchema`'s four values. A blind
 * cast here would be trusting a boundary the database does not actually
 * guarantee, so `status` is validated (not cast) via {@link toInstrumentStatus}
 * -- the same fail-loudly posture `mapInstrumentRow`'s `requireSpecialization`
 * takes for its own DB-guaranteed invariant, applied here to one that isn't
 * yet DB-guaranteed. Every write path into `instrument.status` today is
 * Task 13's own tests and the seed (both always `'ACTIVE'`); Task 15's
 * `POST`/`PATCH /instruments` must validate against this same
 * `instrumentStatusSchema` at the write boundary, or a future bad value
 * would surface here as a 500 rather than being rejected at write time.
 */
function toInstrumentRow(row: InstrumentWithSpecializations): InstrumentRow {
  return {
    ...row,
    instrumentType: row.instrumentType as InstrumentTypeCode,
    status: toInstrumentStatus(row.id, row.status),
  };
}

/**
 * Validates `status` against `instrumentStatusSchema` rather than casting it
 * (F14.1, fix round 1) -- see {@link toInstrumentRow}'s doc comment for why
 * this field, alone among the base row's fields, cannot be trusted as a cast.
 * Throws a descriptive error naming the offending instrument and value,
 * mirroring `mapInstrumentRow`'s `requireSpecialization`.
 *
 * Exported (only) so `instrument.service.spec.ts` can exercise the
 * malformed-status path directly, without standing up a `PrismaService` --
 * every other export of this file is the injectable `InstrumentService`.
 */
export function toInstrumentStatus(instrumentId: string, status: string): InstrumentStatus {
  const result = instrumentStatusSchema.safeParse(status);
  if (!result.success) {
    throw new Error(
      `Instrument ${instrumentId} has an unrecognized status: ${JSON.stringify(status)}`,
    );
  }
  return result.data;
}
