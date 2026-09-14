import { z } from 'zod';

/**
 * Wire contracts for `/instruments` (`SPEC-catalog.md` §API Surface). One
 * definition of each shape, here: the API validates requests against these
 * schemas and every client infers its types from them. Nothing in this file
 * imports from `apps/*` -- it is schemas and types only.
 *
 * Task 14 scope only: `GET /instruments` (search) and `GET /instruments/:id`
 * (one, as a discriminated union). `POST`/`PATCH /instruments` are Task 15.
 */

/** `instrument.instrument_type` discriminator (`SPEC-catalog.md` §instrument). */
export const instrumentTypeSchema = z.enum(['EQUITY', 'ETF', 'FIXED_INCOME', 'CRYPTO']);
export type InstrumentTypeContract = z.infer<typeof instrumentTypeSchema>;

/**
 * `instrument.status` (`SPEC-catalog.md` §instrument, Ruling S6 -- the
 * 4-value entity-dictionary set).
 */
export const instrumentStatusSchema = z.enum(['ACTIVE', 'DELISTED', 'MATURED', 'SUSPENDED']);
export type InstrumentStatusContract = z.infer<typeof instrumentStatusSchema>;

/**
 * A `Decimal`-backed field on the wire: a string, never a JSON number
 * (`SPEC.md` §Boundaries: never `number`, never `parseFloat` for money).
 * Unlike `portfolio.ts`'s `targetAmountSchema` this is not pinned to one
 * fixed number of decimal places -- `instrument`'s money columns carry
 * different scales (`expense_ratio` decimal(6,4), `contracted_rate`
 * decimal(10,6), `index_percentage` decimal(10,4), `face_value`
 * decimal(20,6)) -- so this only rejects the shapes a `Decimal.toFixed()`
 * can never produce (a leading `-` is allowed: `contracted_rate` can be a
 * negative spread).
 */
const decimalStringSchema = z
  .string()
  .trim()
  .regex(/^-?\d+(\.\d+)?$/, 'must be a decimal string');

/** ISO-8601 calendar date, e.g. "2035-06-30". No time component. */
const dateOnlySchema = z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be a date in YYYY-MM-DD format');

/** Fields every variant of the response union carries. */
const instrumentCommonSchema = {
  id: z.string().uuid(),
  /**
   * Null = public catalog; non-null = the caller's own private instrument.
   * Never a *different* user's id: `GET /instruments` and `GET
   * /instruments/:id` only ever return a public row or one the caller owns
   * (`instrument.service.ts` scopes visibility in the query), so this value
   * is always either `null` or the calling user's own id -- it cannot leak
   * another user's identity.
   */
  ownerUserId: z.string().uuid().nullable(),
  name: z.string(),
  currencyCode: z.string(),
  dataSourceId: z.string().uuid().nullable(),
  status: instrumentStatusSchema,
  isVariableIncome: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
};

export const equityInstrumentResponseSchema = z.object({
  ...instrumentCommonSchema,
  instrumentType: z.literal('EQUITY'),
  ticker: z.string(),
  exchangeCode: z.string(),
  isin: z.string().nullable(),
  sector: z.string().nullable(),
  countryCode: z.string().nullable(),
});
export type EquityInstrumentResponse = z.infer<typeof equityInstrumentResponseSchema>;

export const etfInstrumentResponseSchema = z.object({
  ...instrumentCommonSchema,
  instrumentType: z.literal('ETF'),
  ticker: z.string(),
  exchangeCode: z.string(),
  isin: z.string().nullable(),
  benchmarkIndex: z.string().nullable(),
  expenseRatio: decimalStringSchema.nullable(),
  replicationMethod: z.string().nullable(),
});
export type EtfInstrumentResponse = z.infer<typeof etfInstrumentResponseSchema>;

export const fixedIncomeInstrumentResponseSchema = z.object({
  ...instrumentCommonSchema,
  instrumentType: z.literal('FIXED_INCOME'),
  issuerName: z.string(),
  issuerTaxId: z.string().nullable(),
  indexationType: z.string(),
  contractedRate: decimalStringSchema.nullable(),
  indexPercentage: decimalStringSchema.nullable(),
  issueDate: dateOnlySchema,
  maturityDate: dateOnlySchema,
  couponFrequency: z.string(),
  dayCountConvention: z.string(),
  faceValue: decimalStringSchema.nullable(),
  allowsEarlyRedemption: z.boolean(),
  taxRegime: z.string().nullable(),
});
export type FixedIncomeInstrumentResponse = z.infer<typeof fixedIncomeInstrumentResponseSchema>;

export const cryptoInstrumentResponseSchema = z.object({
  ...instrumentCommonSchema,
  instrumentType: z.literal('CRYPTO'),
  symbol: z.string(),
  network: z.string().nullable(),
  contractAddress: z.string().nullable(),
  decimals: z.number().int(),
});
export type CryptoInstrumentResponse = z.infer<typeof cryptoInstrumentResponseSchema>;

/**
 * `GET /instruments/:id` response, and the shape of each entry in `GET
 * /instruments`. A zod discriminated union on `instrumentType` mirrors
 * `domain/instrument.ts`'s TypeScript union on the API side -- the same
 * exhaustiveness guarantee, at the schema layer.
 */
export const instrumentResponseSchema = z.discriminatedUnion('instrumentType', [
  equityInstrumentResponseSchema,
  etfInstrumentResponseSchema,
  fixedIncomeInstrumentResponseSchema,
  cryptoInstrumentResponseSchema,
]);
export type InstrumentResponse = z.infer<typeof instrumentResponseSchema>;

export const instrumentsResponseSchema = z.array(instrumentResponseSchema);
export type InstrumentsResponse = z.infer<typeof instrumentsResponseSchema>;

/**
 * `GET /instruments` query params (`SPEC-catalog.md`: "Search filters by
 * type, ticker and name"). `type` is an exact match against the
 * discriminator. `ticker` and `name` are case-insensitive substring matches
 * (Postgres `ILIKE` via Prisma's `mode: 'insensitive'`) -- exact matching
 * would make the search box useless for anything but a full, correctly-cased
 * ticker, and this is a search endpoint, not a lookup-by-key one.
 * `.strict()` turns an unrecognized query param into a 400 rather than a
 * silently-ignored one.
 */
export const instrumentSearchQuerySchema = z
  .object({
    type: instrumentTypeSchema.optional(),
    ticker: z.string().trim().min(1).max(16).optional(),
    name: z.string().trim().min(1).max(255).optional(),
  })
  .strict();
export type InstrumentSearchQuery = z.infer<typeof instrumentSearchQuerySchema>;
export type InstrumentSearchQueryInput = z.input<typeof instrumentSearchQuerySchema>;
