import { z } from 'zod';

/**
 * Wire contracts for `/instruments` (`SPEC-catalog.md` §API Surface). One
 * definition of each shape, here: the API validates requests against these
 * schemas and every client infers its types from them. Nothing in this file
 * imports from `apps/*` -- it is schemas and types only.
 *
 * Task 14: `GET /instruments` (search) and `GET /instruments/:id` (one, as a
 * discriminated union). Task 15 adds `POST`/`PATCH /instruments` -- FIXED
 * INCOME only (`SPEC-catalog.md` §API Surface: "Create a **private**
 * instrument (fixed income)"); equity/ETF/crypto creation is out of scope.
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
 * Parameterized by the backing column's actual `NUMERIC(precision, scale)`
 * (`SPEC-catalog.md`) -- unlike `portfolio.ts`'s `targetAmountSchema`,
 * `instrument`'s four decimal fields carry different scales
 * (`expense_ratio` decimal(6,4), `contracted_rate` decimal(10,6),
 * `index_percentage` decimal(10,4), `face_value` decimal(20,6)), so one
 * fixed regex can't bound all of them.
 *
 * Both the integer-digit count and the decimal-place count are bounded
 * (not just the shape a `Decimal.toFixed()` can produce): an unbounded
 * integer part lets a client send more digits than the column holds, which
 * reaches Postgres as `22003 numeric field overflow` -- none of the three
 * services' Prisma-error mapping catches that code, so it previously
 * surfaced as an unhandled 500 instead of a 400 (final-review fix). A
 * leading `-` is always allowed: `contracted_rate` can be a negative spread.
 */
function decimalStringSchema(integerDigits: number, decimalPlaces: number) {
  return z
    .string()
    .trim()
    .regex(
      new RegExp(`^-?\\d{1,${integerDigits}}(\\.\\d{1,${decimalPlaces}})?$`),
      `must be a decimal string with at most ${integerDigits} integer digit(s) and ${decimalPlaces} decimal place(s)`,
    );
}

/** `instrument_etf.expense_ratio decimal(6,4)` -- 2 integer digits. */
const expenseRatioSchema = decimalStringSchema(2, 4);
/** `instrument_fixed_income.contracted_rate decimal(10,6)` -- 4 integer digits. */
const contractedRateSchema = decimalStringSchema(4, 6);
/** `instrument_fixed_income.index_percentage decimal(10,4)` -- 6 integer digits. */
const indexPercentageSchema = decimalStringSchema(6, 4);
/** `instrument_fixed_income.face_value decimal(20,6)` -- 14 integer digits. */
const faceValueSchema = decimalStringSchema(14, 6);

/**
 * `YYYY-MM-DD` -> whether it names a real calendar date, not just a string
 * matching the shape. `new Date(...)` alone cannot answer this: JS silently
 * ROLLS OVER an out-of-range day/month rather than rejecting it (`new
 * Date('2024-02-30')` becomes `2024-03-01`), so a naive `Date` round-trip
 * would let a client's "2024-02-30" become a silently different persisted
 * date rather than a 400 (fix round 1, F15.2 -- this is the first place
 * `dateOnlySchema`'s output gets turned into a stored `Date`, on `POST`
 * `create` and the `PATCH` merge in `instrument.service.ts`). Re-deriving
 * the UTC year/month/day from the constructed `Date` and comparing them back
 * against the parsed input catches exactly the rollover a plain `isNaN(...)`
 * check would miss, since a rolled-over date is still a perfectly valid
 * `Date` object.
 */
function isRealCalendarDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (match === null) {
    return false;
  }
  const [, yearStr, monthStr, dayStr] = match;
  const year = Number(yearStr);
  const month = Number(monthStr);
  const day = Number(dayStr);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}

/**
 * ISO-8601 calendar date, e.g. "2035-06-30". No time component. Rejects both
 * a malformed shape (the regex) and a well-shaped but non-existent date like
 * "2024-02-30" (the refine -- see {@link isRealCalendarDate}).
 */
const dateOnlySchema = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'must be a date in YYYY-MM-DD format')
  .refine(isRealCalendarDate, { message: 'must be a real calendar date' });

/** ISO 4217 alpha-3, upper-case. Existence is enforced by the database FK to `currency`. */
const currencyCodeSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z]{3}$/, 'must be a 3-letter ISO 4217 currency code');

/**
 * `instrument_fixed_income.indexation_type` (`SPEC-catalog.md` §instrument_fixed_income):
 * `PRE` (pre-fixed), `CDI`, `IPCA`, `SELIC`. A closed set, unlike
 * `day_count_convention`/`tax_regime` which the entity dictionary only gives
 * "e.g." examples for -- those stay free-form strings below.
 */
export const indexationTypeSchema = z.enum(['PRE', 'CDI', 'IPCA', 'SELIC']);
export type IndexationType = z.infer<typeof indexationTypeSchema>;

/** `instrument_fixed_income.coupon_frequency` -- also a documented closed set. */
export const couponFrequencySchema = z.enum(['NONE', 'MONTHLY', 'SEMIANNUAL', 'ANNUAL']);
export type CouponFrequency = z.infer<typeof couponFrequencySchema>;

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
  expenseRatio: expenseRatioSchema.nullable(),
  replicationMethod: z.string().nullable(),
});
export type EtfInstrumentResponse = z.infer<typeof etfInstrumentResponseSchema>;

export const fixedIncomeInstrumentResponseSchema = z.object({
  ...instrumentCommonSchema,
  instrumentType: z.literal('FIXED_INCOME'),
  issuerName: z.string(),
  issuerTaxId: z.string().nullable(),
  indexationType: z.string(),
  contractedRate: contractedRateSchema.nullable(),
  indexPercentage: indexPercentageSchema.nullable(),
  issueDate: dateOnlySchema,
  maturityDate: dateOnlySchema,
  couponFrequency: z.string(),
  dayCountConvention: z.string(),
  faceValue: faceValueSchema.nullable(),
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
 * `POST /instruments` request (`SPEC-catalog.md` §API Surface: "Create a
 * **private** instrument (fixed income)"). FIXED INCOME only -- Task 15's
 * scope, per the brief; there is no equity/ETF/crypto create request here.
 *
 * Deliberately absent, and therefore a 400 via `.strict()` if sent:
 * `ownerUserId` (always the caller, from `@CurrentUser()`), `instrumentType`
 * (always `'FIXED_INCOME'`), `status` (server-defaulted to `'ACTIVE'`),
 * `isVariableIncome` (always `false`, matching the `instrument_is_variable_income_chk`
 * CHECK), `dataSourceId` (always `null` -- this endpoint only ever creates
 * manually-maintained instruments, never ingested ones). All five are
 * server-determined, never client-settable, so leaving them out of the
 * schema entirely -- rather than accepting and ignoring them -- is what makes
 * an attempt to set any of them a rejection, not a silent no-op.
 */
export const createFixedIncomeInstrumentRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(255),
    currencyCode: currencyCodeSchema,
    issuerName: z.string().trim().min(1).max(255),
    issuerTaxId: z.string().trim().min(1).max(32).nullish(),
    indexationType: indexationTypeSchema,
    contractedRate: contractedRateSchema.nullish(),
    indexPercentage: indexPercentageSchema.nullish(),
    issueDate: dateOnlySchema,
    maturityDate: dateOnlySchema,
    couponFrequency: couponFrequencySchema,
    dayCountConvention: z.string().trim().min(1).max(16),
    faceValue: faceValueSchema.nullish(),
    allowsEarlyRedemption: z.boolean(),
    taxRegime: z.string().trim().min(1).max(24).nullish(),
  })
  .strict()
  .refine((data) => new Date(data.maturityDate) > new Date(data.issueDate), {
    message: 'maturityDate must be strictly after issueDate',
    path: ['maturityDate'],
  });
export type CreateFixedIncomeInstrumentRequest = z.infer<
  typeof createFixedIncomeInstrumentRequestSchema
>;
export type CreateFixedIncomeInstrumentRequestInput = z.input<
  typeof createFixedIncomeInstrumentRequestSchema
>;

/**
 * `PATCH /instruments/:id` request. Every field the create schema accepts,
 * plus `status` (Ruling S6's 4-value set -- there is no database CHECK on
 * `instrument.status`, so this is the one write-time guard for it, same as
 * `create`'s hardcoded `'ACTIVE'`). Still never `ownerUserId`,
 * `instrumentType`, `isVariableIncome`, `dataSourceId` -- `.strict()` rejects
 * an attempt to change any of them, the same as create.
 *
 * `.partial()`: omit a key to leave it unchanged. Every field here backs a
 * `NOT NULL` column (`SPEC-catalog.md` §instrument_fixed_income), so unlike
 * `updatePortfolioRequestSchema` none of the nullable-columns are `.nullable()`
 * here -- unset is "don't touch", there is no "clear" for a required field.
 * The exceptions are the four columns that are themselves nullable in the
 * schema (`issuerTaxId`, `contractedRate`, `indexPercentage`, `faceValue`,
 * `taxRegime`), which accept `null` to clear them, same as `create`.
 *
 * The `maturityDate`-after-`issueDate` invariant can only be fully checked
 * here when a patch supplies *both* dates together (this schema has no view
 * of whichever one is not in the patch); `instrument.service.ts`'s `update`
 * merges the patch onto the current row and re-validates the merged pair
 * before writing, so a patch that only moves one of the two dates is still
 * caught.
 */
export const updateFixedIncomeInstrumentRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(255),
    currencyCode: currencyCodeSchema,
    status: instrumentStatusSchema,
    issuerName: z.string().trim().min(1).max(255),
    issuerTaxId: z.string().trim().min(1).max(32).nullable(),
    indexationType: indexationTypeSchema,
    contractedRate: contractedRateSchema.nullable(),
    indexPercentage: indexPercentageSchema.nullable(),
    issueDate: dateOnlySchema,
    maturityDate: dateOnlySchema,
    couponFrequency: couponFrequencySchema,
    dayCountConvention: z.string().trim().min(1).max(16),
    faceValue: faceValueSchema.nullable(),
    allowsEarlyRedemption: z.boolean(),
    taxRegime: z.string().trim().min(1).max(24).nullable(),
  })
  .partial()
  .strict()
  .refine((patch) => Object.values(patch).some((value) => value !== undefined), {
    message: 'at least one field is required',
  })
  .refine(
    (patch) =>
      patch.issueDate === undefined ||
      patch.maturityDate === undefined ||
      new Date(patch.maturityDate) > new Date(patch.issueDate),
    { message: 'maturityDate must be strictly after issueDate', path: ['maturityDate'] },
  );
export type UpdateFixedIncomeInstrumentRequest = z.infer<
  typeof updateFixedIncomeInstrumentRequestSchema
>;
export type UpdateFixedIncomeInstrumentRequestInput = z.input<
  typeof updateFixedIncomeInstrumentRequestSchema
>;

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
