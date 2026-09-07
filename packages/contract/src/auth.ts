import { z } from 'zod';

/**
 * Wire contracts for `POST /auth/register` and `POST /auth/login`
 * (`SPEC-identity.md` §API Surface, ADR 0003).
 *
 * One definition of each shape, here: the API validates requests against these
 * schemas and every client infers its types from them. Nothing in this file
 * imports from `apps/*` -- it is schemas and types only.
 */

/**
 * Transport a session's tokens travel over. Mirrors the Prisma `ClientType`
 * enum, but declared here independently so a client never imports from the API.
 * `WEB` is the default when a request does not say (`SPEC-identity.md`
 * §"Transport differs per client").
 */
export const clientTypeSchema = z.enum(['WEB', 'ANDROID']);
export type ClientTypeContract = z.infer<typeof clientTypeSchema>;

/**
 * Password policy: minimum 12 characters, no composition rules
 * (`SPEC-identity.md` §Open Questions -> resolved in the Task 9 brief). The
 * upper bound is a denial-of-service guard: argon2id hashes the entire input,
 * so an unbounded password is an unbounded amount of work per request.
 */
const passwordSchema = z
  .string()
  .min(12, 'password must be at least 12 characters')
  .max(256, 'password must be at most 256 characters'); // DoS cap; value is never stored (hashed)

const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(3)
  .max(255) // mirrors db column width (SPEC-identity.md)
  .email('must be a valid email address');

/** ISO 4217 alpha-3, upper-case. Existence is enforced by the database FK. */
const currencyCodeSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z]{3}$/, 'must be a 3-letter ISO 4217 currency code');

export const registerRequestSchema = z.object({
  email: emailSchema,
  password: passwordSchema,
  displayName: z.string().trim().min(1).max(128), // mirrors db column width (SPEC-identity.md)
  baseCurrencyCode: currencyCodeSchema.default('BRL'),
  timezone: z.string().trim().min(1).max(64).default('UTC'),
  clientType: clientTypeSchema.default('WEB'),
});
export type RegisterRequest = z.infer<typeof registerRequestSchema>;
/** The pre-parse shape a caller may send (defaults/optionals not yet applied). */
export type RegisterRequestInput = z.input<typeof registerRequestSchema>;

export const loginRequestSchema = z.object({
  email: emailSchema,
  // No minimum-length check on login: the policy is enforced at registration,
  // and rejecting a short password here would only tell an attacker their guess
  // was too short to be real. Bounded above for the same DoS reason as above.
  password: z.string().min(1).max(256), // DoS cap (never stored)
  clientType: clientTypeSchema.default('WEB'),
});
export type LoginRequest = z.infer<typeof loginRequestSchema>;
export type LoginRequestInput = z.input<typeof loginRequestSchema>;

/**
 * The success body for both endpoints. The access token is always present. The
 * refresh token is present ONLY for an `ANDROID` client -- for `WEB` it is
 * delivered as an `HttpOnly` cookie and must never appear in a response body
 * (`SPEC-identity.md` §"Transport differs per client").
 */
export const authResponseSchema = z.object({
  accessToken: z.string(),
  tokenType: z.literal('Bearer'),
  /** Access-token lifetime in seconds (900 = 15 minutes, ADR 0003). */
  expiresIn: z.number().int().positive(),
  refreshToken: z.string().optional(),
});
export type AuthResponse = z.infer<typeof authResponseSchema>;
