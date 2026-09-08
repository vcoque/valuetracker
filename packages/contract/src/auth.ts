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

/**
 * `POST /auth/refresh` request. The refresh token reaches the server by the
 * transport its `clientType` dictates (`SPEC-identity.md` §"Transport differs
 * per client"):
 *
 *  - `WEB`     -> the `refresh_token` cookie, path-scoped to `/auth/refresh`;
 *                 `refreshToken` in the body is ignored.
 *  - `ANDROID` -> `refreshToken` in this body (no cookie jar).
 *
 * `clientType` defaults to `WEB`, matching register/login.
 */
export const refreshRequestSchema = z.object({
  refreshToken: z.string().min(1).max(512).optional(), // opaque base64url; bounded to cap work
  clientType: clientTypeSchema.default('WEB'),
});
export type RefreshRequest = z.infer<typeof refreshRequestSchema>;
export type RefreshRequestInput = z.input<typeof refreshRequestSchema>;

/**
 * `GET /auth/me` / `PATCH /auth/me` response: the caller's own profile. Carries
 * no password hash and no tokens -- the credential lives on a separate table
 * precisely so a user read cannot leak it (`SPEC-identity.md` §user_credential).
 * `createdAt` is an ISO-8601 string on the wire.
 */
export const meResponseSchema = z.object({
  id: z.string().uuid(),
  email: z.string().email(),
  displayName: z.string(),
  baseCurrencyCode: z.string(),
  timezone: z.string(),
  createdAt: z.string(),
});
export type MeResponse = z.infer<typeof meResponseSchema>;

/**
 * `PATCH /auth/me` request. Only these three fields may be changed
 * (`SPEC-identity.md` §API Surface); `.strict()` makes any other key a 400 --
 * a client cannot patch its own `email` or `id` through this route. At least
 * one field must be present, so an empty patch is rejected rather than being a
 * silent no-op. `baseCurrencyCode` existence is enforced by the database FK to
 * `currency` (an unknown code is a 400, not a 500).
 */
export const updateMeRequestSchema = z
  .object({
    displayName: z.string().trim().min(1).max(128),
    baseCurrencyCode: currencyCodeSchema,
    timezone: z.string().trim().min(1).max(64),
  })
  .partial()
  .strict()
  .refine(
    (patch) =>
      patch.displayName !== undefined ||
      patch.baseCurrencyCode !== undefined ||
      patch.timezone !== undefined,
    { message: 'at least one of displayName, baseCurrencyCode, timezone is required' },
  );
export type UpdateMeRequest = z.infer<typeof updateMeRequestSchema>;
export type UpdateMeRequestInput = z.input<typeof updateMeRequestSchema>;

/**
 * One entry in `GET /auth/sessions` -- a logged-in device. `id` is the internal
 * session id (safe to expose: it is never accepted as a credential). `current`
 * marks the session the calling access token was minted for. `issuedAt` is an
 * ISO-8601 string; `lastUserAgent` and `ip` are nullable (they are optional
 * columns, `SPEC-identity.md` §session).
 */
export const sessionSummarySchema = z.object({
  id: z.string().uuid(),
  clientType: clientTypeSchema,
  issuedAt: z.string(),
  lastUserAgent: z.string().nullable(),
  ip: z.string().nullable(),
  current: z.boolean(),
});
export type SessionSummary = z.infer<typeof sessionSummarySchema>;

export const sessionsResponseSchema = z.array(sessionSummarySchema);
export type SessionsResponse = z.infer<typeof sessionsResponseSchema>;
