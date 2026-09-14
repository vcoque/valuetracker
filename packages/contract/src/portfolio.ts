import { z } from 'zod';

/**
 * Wire contracts for `/portfolios` (`SPEC-portfolio.md` §API Surface). One
 * definition of each shape, here: the API validates requests against these
 * schemas and every client infers its types from them. Nothing in this file
 * imports from `apps/*` -- it is schemas and types only.
 */

/** ISO 4217 alpha-3, upper-case. Existence is enforced by the database FK. */
const currencyCodeSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z]{3}$/, 'must be a 3-letter ISO 4217 currency code');

/**
 * A monetary amount on the wire, e.g. "12345.6700". A string, never a JSON
 * number -- a `number` cannot round-trip an exact decimal, and
 * `target_amount` is stored as `NUMERIC(20,4)` (`SPEC.md` §Boundaries: never
 * `number`, never `parseFloat`). The pattern itself excludes a leading `-`,
 * which is what rejects a negative amount (`SPEC-portfolio.md` AC).
 */
const targetAmountSchema = z
  .string()
  .trim()
  .regex(
    /^\d+(\.\d{1,4})?$/,
    'must be a non-negative decimal with up to 4 decimal places',
  );

/** ISO-8601 calendar date, e.g. "2035-06-30". No time component. */
const targetDateSchema = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'must be a date in YYYY-MM-DD format');

/**
 * `POST /portfolios` request. `objective` is free text, never enum-validated
 * (`SPEC-portfolio.md`: "an enum would force it into a GENERAL bucket that
 * communicates nothing"). `targetAmount` and `targetDate` are independently
 * optional. `baseCurrencyCode` has no default -- `SPEC-portfolio.md` gives
 * none, and it is immutable after creation, so guessing wrong here is
 * permanent.
 */
export const createPortfolioRequestSchema = z.object({
  name: z.string().trim().min(1).max(128), // mirrors db column width (SPEC-portfolio.md)
  description: z.string().trim().min(1).max(512).nullish(),
  objective: z.string().trim().min(1).max(255).nullish(),
  baseCurrencyCode: currencyCodeSchema,
  targetAmount: targetAmountSchema.nullish(),
  targetDate: targetDateSchema.nullish(),
});
export type CreatePortfolioRequest = z.infer<typeof createPortfolioRequestSchema>;
/** The pre-parse shape a caller may send (defaults/optionals not yet applied). */
export type CreatePortfolioRequestInput = z.input<typeof createPortfolioRequestSchema>;

/**
 * `POST /portfolios`, `GET /portfolios` (one entry) and `GET /portfolios/:id`
 * response shape. `targetAmount` travels as a string for the same reason it
 * is validated as one on the way in; `createdAt` is an ISO-8601 string and
 * `targetDate`, when present, is a bare `YYYY-MM-DD` date.
 */
/**
 * `PATCH /portfolios/:id` request (`SPEC-portfolio.md` §API Surface: "Update
 * `name`, `description`, `objective`, `target_amount`, `target_date`").
 * `baseCurrencyCode` and `userId` are simply not fields of this schema, and
 * `.strict()` turns any attempt to send them (or any other unknown key) into
 * a 400 naming the offending key -- the same mechanism `updateMeRequestSchema`
 * (`auth.ts`) uses to keep `email`/`id` off `PATCH /auth/me`. `SPEC-portfolio.md`
 * §Constraints: `base_currency_code` is immutable because changing it would
 * silently redenominate `target_amount` and invalidate every stored snapshot.
 *
 * Each present field is nullable (clears the column) but the field itself is
 * optional (`.partial()`): omit a key to leave it unchanged, send it as
 * `null` to clear it, send a value to set it. At least one key must be
 * present, so an empty patch is rejected rather than a silent no-op.
 */
export const updatePortfolioRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(128),
    description: z.string().trim().min(1).max(512).nullable(),
    objective: z.string().trim().min(1).max(255).nullable(),
    targetAmount: targetAmountSchema.nullable(),
    targetDate: targetDateSchema.nullable(),
  })
  .partial()
  .strict()
  .refine((patch) => Object.values(patch).some((value) => value !== undefined), {
    message:
      'at least one of name, description, objective, targetAmount, targetDate is required',
  });
export type UpdatePortfolioRequest = z.infer<typeof updatePortfolioRequestSchema>;
export type UpdatePortfolioRequestInput = z.input<typeof updatePortfolioRequestSchema>;

export const portfolioResponseSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  description: z.string().nullable(),
  objective: z.string().nullable(),
  baseCurrencyCode: z.string(),
  targetAmount: z.string().nullable(),
  targetDate: z.string().nullable(),
  createdAt: z.string(),
});
export type PortfolioResponse = z.infer<typeof portfolioResponseSchema>;

export const portfoliosResponseSchema = z.array(portfolioResponseSchema);
export type PortfoliosResponse = z.infer<typeof portfoliosResponseSchema>;
