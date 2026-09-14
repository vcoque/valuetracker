/**
 * The `instrument` discriminated union (`SPEC-catalog.md` §"Reads need a
 * discriminated union at the service boundary", `docs/adr/0005-instrument-inheritance.md`).
 *
 * Pure domain code: no Prisma import, no framework, no I/O (`SPEC.md`
 * §Project Structure -- `domain/` is "pure logic, no I/O, no framework
 * imports"). `instrument.service.ts` bridges the real Prisma row (base +
 * `include`d specializations) into the {@link InstrumentRow} shape this file
 * declares; this file only knows about plain data.
 *
 * The whole point of the union: a caller that switches on `instrumentType`
 * gets a **compile error**, not a runtime `undefined`, the day a fifth asset
 * class is added -- see `instrument.spec.ts`'s "exhaustiveness" suite, which
 * reproduces the Task 5 spike's `assertNever` / `@ts-expect-error` proof
 * verbatim (ADR 0005 §"What the spike did", finding 4).
 */

/** `instrument_type` discriminator values (`SPEC-catalog.md` §instrument). */
export type InstrumentTypeCode = 'EQUITY' | 'ETF' | 'FIXED_INCOME' | 'CRYPTO';

/**
 * `instrument.status` (`SPEC-catalog.md` §instrument, Ruling S6 -- the
 * 4-value entity-dictionary set, not the 3-value diagram caption).
 */
export type InstrumentStatus = 'ACTIVE' | 'DELISTED' | 'MATURED' | 'SUSPENDED';

/**
 * Duck-types Prisma's `Decimal` (`toFixed` is all the mapper needs) so this
 * file does not have to import `@prisma/client` just to read a money field.
 */
export interface DecimalLike {
  toFixed(decimalPlaces: number): string;
}

/** Fields common to every row on the base `instrument` table. */
export interface InstrumentBaseRow {
  readonly id: string;
  /** FK to `instrument_type.code`; trusted here, see {@link InstrumentTypeCode}. */
  readonly instrumentType: InstrumentTypeCode;
  /** Null = public catalog; non-null = private to that user. */
  readonly ownerUserId: string | null;
  readonly name: string;
  readonly currencyCode: string;
  readonly dataSourceId: string | null;
  readonly status: InstrumentStatus;
  readonly isVariableIncome: boolean;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface InstrumentEquityRow {
  readonly ticker: string;
  readonly exchangeCode: string;
  readonly isin: string | null;
  readonly sector: string | null;
  readonly countryCode: string | null;
}

export interface InstrumentEtfRow {
  readonly ticker: string;
  readonly exchangeCode: string;
  readonly isin: string | null;
  readonly benchmarkIndex: string | null;
  readonly expenseRatio: DecimalLike | null;
  readonly replicationMethod: string | null;
}

export interface InstrumentFixedIncomeRow {
  readonly issuerName: string;
  readonly issuerTaxId: string | null;
  readonly indexationType: string;
  readonly contractedRate: DecimalLike | null;
  readonly indexPercentage: DecimalLike | null;
  readonly issueDate: Date;
  readonly maturityDate: Date;
  readonly couponFrequency: string;
  readonly dayCountConvention: string;
  readonly faceValue: DecimalLike | null;
  readonly allowsEarlyRedemption: boolean;
  readonly taxRegime: string | null;
}

export interface InstrumentCryptoRow {
  readonly symbol: string;
  readonly network: string | null;
  readonly contractAddress: string | null;
  readonly decimals: number;
}

/**
 * The mapper's input: the base row plus the four optional relations exactly
 * as `prisma.instrument.findUnique({ include: { equity: true, etf: true,
 * fixedIncome: true, crypto: true } })` returns them (Task 13's proven read
 * pattern). Task 13's DB constraints guarantee exactly one of the four is
 * non-null; {@link mapInstrumentRow} still throws defensively if that
 * invariant is ever violated rather than silently returning a wrong shape.
 */
export interface InstrumentRow extends InstrumentBaseRow {
  readonly equity: InstrumentEquityRow | null;
  readonly etf: InstrumentEtfRow | null;
  readonly fixedIncome: InstrumentFixedIncomeRow | null;
  readonly crypto: InstrumentCryptoRow | null;
}

/** Fields every variant of the response union carries. */
interface InstrumentCommon {
  readonly id: string;
  readonly ownerUserId: string | null;
  readonly name: string;
  readonly currencyCode: string;
  readonly dataSourceId: string | null;
  readonly status: InstrumentStatus;
  readonly isVariableIncome: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface EquityInstrument extends InstrumentCommon {
  readonly instrumentType: 'EQUITY';
  readonly ticker: string;
  readonly exchangeCode: string;
  readonly isin: string | null;
  readonly sector: string | null;
  readonly countryCode: string | null;
}

export interface EtfInstrument extends InstrumentCommon {
  readonly instrumentType: 'ETF';
  readonly ticker: string;
  readonly exchangeCode: string;
  readonly isin: string | null;
  readonly benchmarkIndex: string | null;
  /** Annual, as a fraction. Decimal(6,4) on the wire, e.g. "0.0500". */
  readonly expenseRatio: string | null;
  readonly replicationMethod: string | null;
}

export interface FixedIncomeInstrument extends InstrumentCommon {
  readonly instrumentType: 'FIXED_INCOME';
  readonly issuerName: string;
  readonly issuerTaxId: string | null;
  readonly indexationType: string;
  /** Decimal(10,6) on the wire, e.g. "12.500000". */
  readonly contractedRate: string | null;
  /** Decimal(10,4) on the wire, e.g. "110.0000". */
  readonly indexPercentage: string | null;
  /** YYYY-MM-DD, no time component. */
  readonly issueDate: string;
  readonly maturityDate: string;
  readonly couponFrequency: string;
  readonly dayCountConvention: string;
  /** Decimal(20,6) on the wire, e.g. "1000.000000". */
  readonly faceValue: string | null;
  readonly allowsEarlyRedemption: boolean;
  readonly taxRegime: string | null;
}

export interface CryptoInstrument extends InstrumentCommon {
  readonly instrumentType: 'CRYPTO';
  readonly symbol: string;
  readonly network: string | null;
  readonly contractAddress: string | null;
  readonly decimals: number;
}

/**
 * The discriminated union itself. Consumers switch on `instrumentType` and
 * get exhaustiveness checking from the compiler -- see `instrument.spec.ts`.
 */
export type InstrumentView =
  | EquityInstrument
  | EtfInstrument
  | FixedIncomeInstrument
  | CryptoInstrument;

/**
 * `SPEC.md` §Code Style / the Task 5 spike's technique: a `switch` with
 * `default: assertNever(x)` compiles only while every union member is
 * handled. The moment a fifth `instrument_type` is added to
 * {@link InstrumentTypeCode} without a matching `case`, the `default` arm's
 * `x` stops being `never` and this call becomes a type error -- see
 * `instrument.spec.ts`'s "exhaustiveness" suite for the reproduction.
 */
export function assertNever(value: never): never {
  throw new Error(`Unhandled instrument type: ${JSON.stringify(value)}`);
}

/**
 * `row` -> the discriminated union. Ownership/visibility is the caller's
 * job (`instrument.service.ts` scopes the query before this ever runs); this
 * function only reshapes a row it has already been trusted to see.
 *
 * Money fields are serialised via `toFixed` at the column's declared scale
 * (`SPEC-catalog.md` entity dictionary), never `Number`/`parseFloat`
 * (`SPEC.md` §Boundaries). Dates: `issueDate`/`maturityDate` are bare
 * calendar dates (`YYYY-MM-DD`, no time component); `createdAt`/`updatedAt`
 * are full ISO-8601 timestamps.
 */
export function mapInstrumentRow(row: InstrumentRow): InstrumentView {
  const common: InstrumentCommon = {
    id: row.id,
    ownerUserId: row.ownerUserId,
    name: row.name,
    currencyCode: row.currencyCode,
    dataSourceId: row.dataSourceId,
    status: row.status,
    isVariableIncome: row.isVariableIncome,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };

  switch (row.instrumentType) {
    case 'EQUITY': {
      const equity = requireSpecialization(row.id, 'EQUITY', row.equity);
      return {
        ...common,
        instrumentType: 'EQUITY',
        ticker: equity.ticker,
        exchangeCode: equity.exchangeCode,
        isin: equity.isin,
        sector: equity.sector,
        countryCode: equity.countryCode,
      };
    }
    case 'ETF': {
      const etf = requireSpecialization(row.id, 'ETF', row.etf);
      return {
        ...common,
        instrumentType: 'ETF',
        ticker: etf.ticker,
        exchangeCode: etf.exchangeCode,
        isin: etf.isin,
        benchmarkIndex: etf.benchmarkIndex,
        expenseRatio: etf.expenseRatio !== null ? etf.expenseRatio.toFixed(4) : null,
        replicationMethod: etf.replicationMethod,
      };
    }
    case 'FIXED_INCOME': {
      const fixedIncome = requireSpecialization(row.id, 'FIXED_INCOME', row.fixedIncome);
      return {
        ...common,
        instrumentType: 'FIXED_INCOME',
        issuerName: fixedIncome.issuerName,
        issuerTaxId: fixedIncome.issuerTaxId,
        indexationType: fixedIncome.indexationType,
        contractedRate:
          fixedIncome.contractedRate !== null ? fixedIncome.contractedRate.toFixed(6) : null,
        indexPercentage:
          fixedIncome.indexPercentage !== null ? fixedIncome.indexPercentage.toFixed(4) : null,
        issueDate: toDateOnly(fixedIncome.issueDate),
        maturityDate: toDateOnly(fixedIncome.maturityDate),
        couponFrequency: fixedIncome.couponFrequency,
        dayCountConvention: fixedIncome.dayCountConvention,
        faceValue: fixedIncome.faceValue !== null ? fixedIncome.faceValue.toFixed(6) : null,
        allowsEarlyRedemption: fixedIncome.allowsEarlyRedemption,
        taxRegime: fixedIncome.taxRegime,
      };
    }
    case 'CRYPTO': {
      const crypto = requireSpecialization(row.id, 'CRYPTO', row.crypto);
      return {
        ...common,
        instrumentType: 'CRYPTO',
        symbol: crypto.symbol,
        network: crypto.network,
        contractAddress: crypto.contractAddress,
        decimals: crypto.decimals,
      };
    }
    default:
      return assertNever(row.instrumentType);
  }
}

/**
 * Task 13's DB constraints (composite FK + deferred "exactly one" trigger,
 * ADR 0005) guarantee the matching specialization is present. This is the
 * defensive fallback if that invariant is ever violated -- a 500 that names
 * the corrupt row, rather than silently building a response with `undefined`
 * fields.
 */
function requireSpecialization<T>(
  instrumentId: string,
  type: InstrumentTypeCode,
  specialization: T | null,
): T {
  if (specialization === null) {
    throw new Error(
      `Instrument ${instrumentId} is typed ${type} but has no ${type} specialization row`,
    );
  }
  return specialization;
}

/** `Date` -> bare `YYYY-MM-DD`, matching `targetDate`'s treatment in `portfolio.service.ts`. */
function toDateOnly(date: Date): string {
  return date.toISOString().slice(0, 10);
}
