import {
  assertNever,
  type InstrumentRow,
  type InstrumentTypeCode,
  mapInstrumentRow,
} from './instrument';

/** Prisma's `Decimal` has `toFixed`; this is all the mapper needs from it. */
class FakeDecimal {
  constructor(private readonly value: string) {}
  toFixed(decimalPlaces: number): string {
    return Number(this.value).toFixed(decimalPlaces);
  }
}

const CREATED_AT = new Date('2026-01-01T10:00:00.000Z');
const UPDATED_AT = new Date('2026-02-01T12:30:00.000Z');

/** A base row with every specialization null; each test fills in the one it needs. */
function baseRow(
  overrides: Partial<InstrumentRow> & Pick<InstrumentRow, 'instrumentType'>,
): InstrumentRow {
  return {
    id: 'instrument-id',
    ownerUserId: null,
    name: 'Test Instrument',
    currencyCode: 'BRL',
    dataSourceId: null,
    status: 'ACTIVE',
    isVariableIncome: true,
    createdAt: CREATED_AT,
    updatedAt: UPDATED_AT,
    equity: null,
    etf: null,
    fixedIncome: null,
    crypto: null,
    ...overrides,
  };
}

describe('mapInstrumentRow', () => {
  it('maps an EQUITY row', () => {
    const row = baseRow({
      instrumentType: 'EQUITY',
      ownerUserId: 'owner-1',
      equity: {
        ticker: 'PETR4',
        exchangeCode: 'B3',
        isin: 'BRPETRACNPR6',
        sector: 'Energy',
        countryCode: 'BR',
      },
    });

    expect(mapInstrumentRow(row)).toEqual({
      id: 'instrument-id',
      instrumentType: 'EQUITY',
      ownerUserId: 'owner-1',
      name: 'Test Instrument',
      currencyCode: 'BRL',
      dataSourceId: null,
      status: 'ACTIVE',
      isVariableIncome: true,
      createdAt: CREATED_AT.toISOString(),
      updatedAt: UPDATED_AT.toISOString(),
      ticker: 'PETR4',
      exchangeCode: 'B3',
      isin: 'BRPETRACNPR6',
      sector: 'Energy',
      countryCode: 'BR',
    });
  });

  it('maps an ETF row, serialising expenseRatio as a Decimal(6,4) string', () => {
    const row = baseRow({
      instrumentType: 'ETF',
      etf: {
        ticker: 'BOVA11',
        exchangeCode: 'B3',
        isin: null,
        benchmarkIndex: 'IBOVESPA',
        expenseRatio: new FakeDecimal('0.05'),
        replicationMethod: 'PHYSICAL',
      },
    });

    const result = mapInstrumentRow(row);

    expect(result).toEqual({
      id: 'instrument-id',
      instrumentType: 'ETF',
      ownerUserId: null,
      name: 'Test Instrument',
      currencyCode: 'BRL',
      dataSourceId: null,
      status: 'ACTIVE',
      isVariableIncome: true,
      createdAt: CREATED_AT.toISOString(),
      updatedAt: UPDATED_AT.toISOString(),
      ticker: 'BOVA11',
      exchangeCode: 'B3',
      isin: null,
      benchmarkIndex: 'IBOVESPA',
      expenseRatio: '0.0500',
      replicationMethod: 'PHYSICAL',
    });
    // A JSON number can never round-trip an exact decimal (SPEC.md §Boundaries).
    if (result.instrumentType !== 'ETF') {
      throw new Error('expected ETF');
    }
    expect(typeof result.expenseRatio).toBe('string');
  });

  it('maps a null expenseRatio through as null, not "0.0000"', () => {
    const row = baseRow({
      instrumentType: 'ETF',
      etf: {
        ticker: 'IVVB11',
        exchangeCode: 'B3',
        isin: null,
        benchmarkIndex: null,
        expenseRatio: null,
        replicationMethod: null,
      },
    });

    const result = mapInstrumentRow(row);
    if (result.instrumentType !== 'ETF') {
      throw new Error('expected ETF');
    }
    expect(result.expenseRatio).toBeNull();
  });

  it('maps a FIXED_INCOME row, serialising money at each field\'s own scale and dates as YYYY-MM-DD', () => {
    const row = baseRow({
      instrumentType: 'FIXED_INCOME',
      isVariableIncome: false,
      fixedIncome: {
        issuerName: 'Tesouro Nacional',
        issuerTaxId: null,
        indexationType: 'IPCA',
        contractedRate: new FakeDecimal('5.5'),
        indexPercentage: new FakeDecimal('110'),
        issueDate: new Date('2024-01-01T00:00:00.000Z'),
        maturityDate: new Date('2030-01-01T00:00:00.000Z'),
        couponFrequency: 'SEMIANNUAL',
        dayCountConvention: 'BUS252',
        faceValue: new FakeDecimal('1000'),
        allowsEarlyRedemption: false,
        taxRegime: 'EXEMPT',
      },
    });

    expect(mapInstrumentRow(row)).toEqual({
      id: 'instrument-id',
      instrumentType: 'FIXED_INCOME',
      ownerUserId: null,
      name: 'Test Instrument',
      currencyCode: 'BRL',
      dataSourceId: null,
      status: 'ACTIVE',
      isVariableIncome: false,
      createdAt: CREATED_AT.toISOString(),
      updatedAt: UPDATED_AT.toISOString(),
      issuerName: 'Tesouro Nacional',
      issuerTaxId: null,
      indexationType: 'IPCA',
      contractedRate: '5.500000',
      indexPercentage: '110.0000',
      issueDate: '2024-01-01',
      maturityDate: '2030-01-01',
      couponFrequency: 'SEMIANNUAL',
      dayCountConvention: 'BUS252',
      faceValue: '1000.000000',
      allowsEarlyRedemption: false,
      taxRegime: 'EXEMPT',
    });
  });

  it('maps a CRYPTO row', () => {
    const row = baseRow({
      instrumentType: 'CRYPTO',
      crypto: {
        symbol: 'BTC',
        network: 'BITCOIN',
        contractAddress: null,
        decimals: 8,
      },
    });

    expect(mapInstrumentRow(row)).toEqual({
      id: 'instrument-id',
      instrumentType: 'CRYPTO',
      ownerUserId: null,
      name: 'Test Instrument',
      currencyCode: 'BRL',
      dataSourceId: null,
      status: 'ACTIVE',
      isVariableIncome: true,
      createdAt: CREATED_AT.toISOString(),
      updatedAt: UPDATED_AT.toISOString(),
      symbol: 'BTC',
      network: 'BITCOIN',
      contractAddress: null,
      decimals: 8,
    });
  });

  it('throws a descriptive error rather than building a wrong shape when the specialization is missing', () => {
    const row = baseRow({ instrumentType: 'EQUITY', equity: null });

    expect(() => mapInstrumentRow(row)).toThrow(
      'instrument-id is typed EQUITY but has no EQUITY specialization row',
    );
  });
});

/**
 * Reproduces the Task 5 spike's exhaustiveness proof verbatim (ADR 0005
 * §"What the spike did", finding 4; `task-14-brief.md` acceptance criterion:
 * "Adding a fifth instrument_type produces a compile error at every
 * exhaustive switch until handled").
 *
 * `FifthInstrumentType` simulates what `InstrumentTypeCode` would look like
 * after a `'FUND'` variant is added. `describeType` below is a second,
 * independent exhaustive switch (distinct from `mapInstrumentRow`'s) to prove
 * the technique generalises to *any* switch over the union, not just the one
 * in the mapper.
 */
type FifthInstrumentType = InstrumentTypeCode | 'FUND';

function describeType(type: FifthInstrumentType): string {
  switch (type) {
    case 'EQUITY':
      return 'equity';
    case 'ETF':
      return 'etf';
    case 'FIXED_INCOME':
      return 'fixed income';
    case 'CRYPTO':
      return 'crypto';
    default:
      // Once `'FUND'` exists on `FifthInstrumentType`, TypeScript narrows
      // `type` in this branch to `'FUND'`, not `never` -- so passing it to
      // `assertNever` (which only accepts `never`) is a type error. This
      // directive is the proof: removing it must fail `tsc`.
      //
      // Verified manually during development (see task-14-report.md for the
      // full transcript) by deleting the directive below and running
      // `./scripts/dev.sh npm run typecheck` -- it failed with exactly:
      //   TS2345: Argument of type '"FUND"' is not assignable to parameter
      //   of type 'never'.
      // at this call, then the directive was restored.
      // @ts-expect-error -- 'FUND' is not assignable to `never`; see above.
      return assertNever(type);
  }
}

describe('exhaustiveness (type-level proof)', () => {
  it('a variant left unhandled by every real case still reaches the default arm at runtime', () => {
    expect(() => describeType('FUND')).toThrow(
      "Unhandled instrument type: \"FUND\"",
    );
  });

  it('every real InstrumentTypeCode is still handled by an explicit case, not the default', () => {
    expect(describeType('EQUITY')).toBe('equity');
    expect(describeType('ETF')).toBe('etf');
    expect(describeType('FIXED_INCOME')).toBe('fixed income');
    expect(describeType('CRYPTO')).toBe('crypto');
  });
});
