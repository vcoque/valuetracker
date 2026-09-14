/**
 * Request/response shapes for the `/portfolios` endpoints -- one definition of
 * each, in `@valuetracker/contract` (`SPEC.md` §Project Structure). This file
 * only re-exports them so the module's imports read from `./dto/` per the
 * project layout.
 */
export {
  type CreatePortfolioRequest,
  createPortfolioRequestSchema,
  type PortfolioResponse,
  portfolioResponseSchema,
  type PortfoliosResponse,
  portfoliosResponseSchema,
} from '@valuetracker/contract';
