/**
 * Request/response shapes for the `/auth` endpoints. There is one definition of
 * each -- in `@valuetracker/contract` -- validated by the API and inferred by
 * every client (`SPEC.md` §Project Structure). This file only re-exports them so
 * the module's imports read from `./dto/` per the project layout.
 */
export {
  type AuthResponse,
  authResponseSchema,
  type ClientTypeContract,
  type LoginRequest,
  loginRequestSchema,
  type RegisterRequest,
  registerRequestSchema,
} from '@valuetracker/contract';
