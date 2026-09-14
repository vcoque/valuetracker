/**
 * Request/response shapes for the `/instruments` endpoints -- one definition
 * of each, in `@valuetracker/contract` (`SPEC.md` §Project Structure). This
 * file only re-exports them so the module's imports read from `./dto/` per
 * the project layout (mirrors `portfolio/dto/portfolio.dto.ts`).
 */
export {
  type CreateFixedIncomeInstrumentRequest,
  createFixedIncomeInstrumentRequestSchema,
  type CryptoInstrumentResponse,
  cryptoInstrumentResponseSchema,
  type EquityInstrumentResponse,
  equityInstrumentResponseSchema,
  type EtfInstrumentResponse,
  etfInstrumentResponseSchema,
  type FixedIncomeInstrumentResponse,
  fixedIncomeInstrumentResponseSchema,
  type InstrumentResponse,
  instrumentResponseSchema,
  type InstrumentSearchQuery,
  instrumentSearchQuerySchema,
  type InstrumentsResponse,
  instrumentsResponseSchema,
  type InstrumentStatusContract,
  instrumentStatusSchema,
  type InstrumentTypeContract,
  instrumentTypeSchema,
  type UpdateFixedIncomeInstrumentRequest,
  updateFixedIncomeInstrumentRequestSchema,
} from '@valuetracker/contract';
