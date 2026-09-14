import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../../shared/prisma/prisma.service';
import {
  type InstrumentRow,
  type InstrumentStatus,
  type InstrumentTypeCode,
  type InstrumentView,
  mapInstrumentRow,
} from './domain/instrument';
import {
  type CreateFixedIncomeInstrumentRequest,
  type InstrumentSearchQuery,
  instrumentStatusSchema,
  type UpdateFixedIncomeInstrumentRequest,
} from './dto/instrument.dto';

const UNKNOWN_CURRENCY_MESSAGE = 'currencyCode does not match a known currency';
const MATURITY_AFTER_ISSUE_MESSAGE = 'maturityDate must be strictly after issueDate';

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
 * Access to the `instrument` catalog (`SPEC-catalog.md` §API Surface):
 * `GET /instruments`, `GET /instruments/:id` (Task 14), and `POST
 * /instruments` / `PATCH /instruments/:id` (Task 15, FIXED INCOME only).
 *
 * Visibility is scoped **in the query** (`OR: [{ ownerUserId: null },
 * { ownerUserId: userId }]` for reads; `ownerUserId: userId` in `update`'s
 * `findFirst`), never fetch-then-filter (`SPEC.md` §Code Style): a private
 * instrument belonging to someone else must be indistinguishable from one
 * that doesn't exist, so every method applies its ownership predicate before
 * any row ever reaches application code.
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

  /**
   * `POST /instruments`: creates a PRIVATE fixed-income instrument
   * (`SPEC-catalog.md` §API Surface -- this endpoint never creates a public
   * one). `ownerUserId` is always the caller, `instrumentType` is always
   * `'FIXED_INCOME'`, `status` always starts `'ACTIVE'`, `isVariableIncome`
   * is always `false` (matches `instrument_is_variable_income_chk`) and
   * `dataSourceId` is always `null` -- none of these five are accepted from
   * `input` at all (`createFixedIncomeInstrumentRequestSchema` has no such
   * fields), so there is nothing here for a client to override.
   *
   * Base row + `instrument_fixed_income` specialization are written by ONE
   * nested `create` call -- Task 13's proven pattern
   * (`instrument-schema.int-spec.ts` Case 6/7): Prisma wraps a nested
   * `create` in an implicit transaction, so a failure on either insert
   * leaves zero rows of either kind. See `instrument-write.int-spec.ts` for
   * the forced-failure proof.
   */
  async create(
    userId: string,
    input: CreateFixedIncomeInstrumentRequest,
  ): Promise<InstrumentView> {
    try {
      const row = await this.prisma.instrument.create({
        data: {
          instrumentType: 'FIXED_INCOME',
          ownerUserId: userId,
          name: input.name,
          currencyCode: input.currencyCode,
          status: 'ACTIVE',
          isVariableIncome: false,
          fixedIncome: {
            create: {
              issuerName: input.issuerName,
              issuerTaxId: input.issuerTaxId ?? null,
              indexationType: input.indexationType,
              contractedRate: toDecimalOrNull(input.contractedRate),
              indexPercentage: toDecimalOrNull(input.indexPercentage),
              issueDate: new Date(input.issueDate),
              maturityDate: new Date(input.maturityDate),
              couponFrequency: input.couponFrequency,
              dayCountConvention: input.dayCountConvention,
              faceValue: toDecimalOrNull(input.faceValue),
              allowsEarlyRedemption: input.allowsEarlyRedemption,
              taxRegime: input.taxRegime ?? null,
            },
          },
        },
        include: INSTRUMENT_INCLUDE,
      });
      return mapInstrumentRow(toInstrumentRow(row));
    } catch (error) {
      throw mapWriteError(error);
    }
  }

  /**
   * `PATCH /instruments/:id`: updates a private FIXED_INCOME instrument the
   * caller owns. Ownership (and type) is scoped IN THE QUERY **twice**, not
   * just checked once and trusted afterward (`SPEC.md` §Code Style: "scoped
   * in the query... never checked after fetching... not optional"):
   *
   *  1. The pre-check `findFirst({ where: { id, ownerUserId: userId,
   *     instrumentType: 'FIXED_INCOME' } })` below -- needed to read the
   *     CURRENT `issueDate`/`maturityDate` for the merged-date check, and to
   *     return an early 404 before attempting a write at all.
   *  2. The mutating `update()` itself carries the SAME three-field `where`
   *     (Prisma's extended-where-unique: `id` alone satisfies "at least one
   *     unique field", so `ownerUserId`/`instrumentType` ride along as real
   *     AND-ed filters on the write's own query, not a separate check) --
   *     fix round 1, F15.1. A `findFirst` that passes but an `update` whose
   *     `where` was just `{ id }` would still be "checked after fetching" in
   *     substance, even with step 1 in place.
   *
   * `update()` cannot use `portfolio.service.ts#update`'s `updateMany` +
   * count-check pattern verbatim: `updateMany` has no relation support, and
   * this write needs the nested `fixedIncome` relation write alongside the
   * base row's. Someone else's instrument, a PUBLIC one, or one that isn't
   * FIXED_INCOME all 404 here -- a caller can never reach or discover them
   * through this endpoint.
   *
   * `maturityDate`/`issueDate` ordering is re-validated against the MERGED
   * (current + patch) pair, not just what the patch itself supplies: the
   * wire schema's own `.refine()` only catches a patch that sends both
   * dates together, so a patch that moves just one of them still needs this
   * check against whichever date the patch left alone.
   */
  async update(
    userId: string,
    id: string,
    patch: UpdateFixedIncomeInstrumentRequest,
  ): Promise<InstrumentView> {
    const current = await this.prisma.instrument.findFirst({
      where: { id, ownerUserId: userId, instrumentType: 'FIXED_INCOME' },
      include: INSTRUMENT_INCLUDE,
    });
    if (current === null || current.fixedIncome === null) {
      throw new NotFoundException({ message: `Instrument ${id} not found` });
    }

    const nextIssueDate =
      patch.issueDate !== undefined ? new Date(patch.issueDate) : current.fixedIncome.issueDate;
    const nextMaturityDate =
      patch.maturityDate !== undefined
        ? new Date(patch.maturityDate)
        : current.fixedIncome.maturityDate;
    if (nextMaturityDate <= nextIssueDate) {
      throw new BadRequestException({ message: MATURITY_AFTER_ISSUE_MESSAGE });
    }

    try {
      await this.prisma.instrument.update({
        // Extended-where-unique (Prisma's `Prisma.AtLeast<..., 'id' | 'id_instrumentType'>`):
        // `id` alone satisfies "at least one unique field", so `ownerUserId`
        // and `instrumentType` ride along as regular AND-ed filters on the
        // SAME query Prisma sends -- this is the mutating write itself being
        // ownership-scoped (`SPEC.md` §Code Style: "scoped in the query,
        // never checked after fetching... not optional"), not just the
        // `findFirst` pre-check above. If the combined filter matches no row
        // (id gone, wrong owner, or no longer FIXED_INCOME between the
        // `findFirst` and here), Prisma throws P2025, mapped below to the
        // same 404 the `findFirst`-miss branch already returns.
        where: { id, ownerUserId: userId, instrumentType: 'FIXED_INCOME' },
        data: {
          ...(patch.name !== undefined && { name: patch.name }),
          ...(patch.currencyCode !== undefined && { currencyCode: patch.currencyCode }),
          ...(patch.status !== undefined && { status: patch.status }),
          fixedIncome: {
            update: {
              ...(patch.issuerName !== undefined && { issuerName: patch.issuerName }),
              ...(patch.issuerTaxId !== undefined && { issuerTaxId: patch.issuerTaxId }),
              ...(patch.indexationType !== undefined && {
                indexationType: patch.indexationType,
              }),
              ...(patch.contractedRate !== undefined && {
                contractedRate: toDecimalOrNull(patch.contractedRate),
              }),
              ...(patch.indexPercentage !== undefined && {
                indexPercentage: toDecimalOrNull(patch.indexPercentage),
              }),
              ...(patch.issueDate !== undefined && { issueDate: nextIssueDate }),
              ...(patch.maturityDate !== undefined && { maturityDate: nextMaturityDate }),
              ...(patch.couponFrequency !== undefined && {
                couponFrequency: patch.couponFrequency,
              }),
              ...(patch.dayCountConvention !== undefined && {
                dayCountConvention: patch.dayCountConvention,
              }),
              ...(patch.faceValue !== undefined && {
                faceValue: toDecimalOrNull(patch.faceValue),
              }),
              ...(patch.allowsEarlyRedemption !== undefined && {
                allowsEarlyRedemption: patch.allowsEarlyRedemption,
              }),
              ...(patch.taxRegime !== undefined && { taxRegime: patch.taxRegime }),
            },
          },
        },
      });
    } catch (error) {
      throw mapWriteError(error, id);
    }

    return this.findVisibleById(userId, id);
  }
}

/** `null | undefined` -> `null`; a decimal string -> `Prisma.Decimal`. */
function toDecimalOrNull(value: string | null | undefined): Prisma.Decimal | null {
  return value != null ? new Prisma.Decimal(value) : null;
}

/**
 * The only foreign key a client influences on this write path is
 * `currency_code` -> `currency.code` (`currencyCode` is free-form
 * AAA..ZZZ at the wire schema, but only seeded codes exist) -- same P2003
 * mapping `portfolio.service.ts#create` uses. Anything else is a genuine
 * server error, not a client mistake, so it rethrows unchanged.
 *
 * `notFoundId`, when given, maps P2025 ("record not found") -- what
 * `update`'s now ownership-+type-scoped `where` throws when nothing matches
 * -- to the same `NotFoundException` shape `findFirst`'s miss branch already
 * returns, so tightening that query (fix round 1, F15.1) does not change the
 * 404 behaviour a caller sees. `create` never passes it: a bare `create` has
 * no `where` clause to come back P2025.
 */
function mapWriteError(error: unknown, notFoundId?: string): unknown {
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    if (error.code === 'P2003' && JSON.stringify(error.meta ?? {}).includes('currency_code')) {
      return new BadRequestException({ message: UNKNOWN_CURRENCY_MESSAGE });
    }
    if (error.code === 'P2025' && notFoundId !== undefined) {
      return new NotFoundException({ message: `Instrument ${notFoundId} not found` });
    }
  }
  return error;
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
