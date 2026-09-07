/**
 * ============================================================================
 * THROWAWAY SPIKE -- Task 5. NOT production code. Delete this whole `_spike/`
 * directory once Task 13 lands the real `catalog` module.
 * ============================================================================
 *
 * Behaviour 4 of the gate (`SPEC-catalog.md` §"The inheritance mapping is the
 * hard part", point 2): the public shape of an instrument is a TypeScript
 * discriminated union on `instrumentType`, consumed through an exhaustive
 * `switch` whose `default` arm calls `assertNever`. Adding a fifth
 * `instrument_type` must be a COMPILE error at every such switch until it is
 * handled.
 *
 * "It fails to compile" is made an executable assertion with `// @ts-expect-error`
 * on a deliberately-unhandled fifth case: if the exhaustiveness check ever stops
 * working, `assertNever(fund)` type-checks, the directive becomes unused, and
 * `tsc` fails with TS2578 ("Unused '@ts-expect-error' directive"). Confirmed by
 * removing the directive and running `npm run typecheck` -- see
 * `.superpowers/sdd/plan/task-5-report.md`.
 */

// --- The discriminated union at the service boundary ------------------------

interface InstrumentEquity {
  readonly instrumentType: 'EQUITY';
  readonly ticker: string;
  readonly exchangeCode: string;
}
interface InstrumentEtf {
  readonly instrumentType: 'ETF';
  readonly ticker: string;
  readonly benchmarkIndex: string | null;
}
interface InstrumentFixedIncome {
  readonly instrumentType: 'FIXED_INCOME';
  readonly issuerName: string;
  readonly maturityDate: string;
}
interface InstrumentCrypto {
  readonly instrumentType: 'CRYPTO';
  readonly symbol: string;
  readonly network: string | null;
}

type Instrument =
  | InstrumentEquity
  | InstrumentEtf
  | InstrumentFixedIncome
  | InstrumentCrypto;

function assertNever(value: never): never {
  throw new Error(`unhandled instrument variant: ${JSON.stringify(value)}`);
}

/** The consumer. Its `default` arm is what enforces exhaustiveness. */
function describeInstrument(instrument: Instrument): string {
  switch (instrument.instrumentType) {
    case 'EQUITY':
      return `${instrument.ticker} on ${instrument.exchangeCode}`;
    case 'ETF':
      return `${instrument.ticker} tracking ${instrument.benchmarkIndex ?? 'n/a'}`;
    case 'FIXED_INCOME':
      return `${instrument.issuerName} maturing ${instrument.maturityDate}`;
    case 'CRYPTO':
      return `${instrument.symbol} on ${instrument.network ?? 'n/a'}`;
    default:
      // `instrument` is `never` here only because all four cases are handled.
      return assertNever(instrument);
  }
}

// --- The fifth-case proof --------------------------------------------------

interface InstrumentFund {
  readonly instrumentType: 'FUND';
  readonly fundManager: string;
}

/** A future asset class, added to the union but NOT handled in the switch. */
type InstrumentWithFifthClass = Instrument | InstrumentFund;

function describeWithUnhandledFifthClass(
  instrument: InstrumentWithFifthClass,
): string {
  switch (instrument.instrumentType) {
    case 'EQUITY':
      return instrument.ticker;
    case 'ETF':
      return instrument.ticker;
    case 'FIXED_INCOME':
      return instrument.issuerName;
    case 'CRYPTO':
      return instrument.symbol;
    default:
      // 'FUND' is deliberately unhandled, so here `instrument` is
      // `InstrumentFund`, not `never`. `assertNever` rejects it at compile
      // time; the directive turns that expected error into a passing assertion.
      // Remove the directive and `tsc` fails -- either TS2345 (this arm) or,
      // once someone adds `case 'FUND':`, TS2578 (unused directive). Both mean
      // the compiler is still enforcing exhaustiveness.
      // @ts-expect-error exhaustiveness: a fifth instrument_type must not compile until it is handled
      return assertNever(instrument);
  }
}

describe('SPIKE (throwaway): instrument discriminated union', () => {
  it('narrows each variant through the exhaustive switch', () => {
    expect(
      describeInstrument({
        instrumentType: 'EQUITY',
        ticker: 'PETR4',
        exchangeCode: 'B3',
      }),
    ).toBe('PETR4 on B3');
    expect(
      describeInstrument({
        instrumentType: 'ETF',
        ticker: 'BOVA11',
        benchmarkIndex: 'IBOVESPA',
      }),
    ).toBe('BOVA11 tracking IBOVESPA');
    expect(
      describeInstrument({
        instrumentType: 'FIXED_INCOME',
        issuerName: 'Tesouro Nacional',
        maturityDate: '2030-01-01',
      }),
    ).toBe('Tesouro Nacional maturing 2030-01-01');
    expect(
      describeInstrument({
        instrumentType: 'CRYPTO',
        symbol: 'BTC',
        network: null,
      }),
    ).toBe('BTC on n/a');
  });

  it('reaches assertNever at runtime only when a variant is genuinely unhandled', () => {
    // The compiler already objects to this call (hence the @ts-expect-error in
    // the function); at runtime the unhandled arm throws rather than silently
    // returning undefined.
    expect(() =>
      describeWithUnhandledFifthClass({
        instrumentType: 'FUND',
        fundManager: 'ACME Asset Mgmt',
      }),
    ).toThrow(/unhandled instrument variant/);
  });

  it('still narrows the original four variants when the fifth is present in the type', () => {
    expect(
      describeWithUnhandledFifthClass({
        instrumentType: 'EQUITY',
        ticker: 'VALE3',
        exchangeCode: 'B3',
      }),
    ).toBe('VALE3');
  });
});
