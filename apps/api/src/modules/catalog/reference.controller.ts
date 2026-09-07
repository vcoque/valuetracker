import { Controller, Get } from '@nestjs/common';

import {
  type CurrencyView,
  type ExchangeView,
  ReferenceService,
} from './reference.service';

/**
 * Reference-data endpoints for the `catalog` module: the currencies and
 * exchanges everything else is denominated in and traded on.
 *
 * TODO(Task 10): @UseGuards(AuthGuard) once identity lands. SPEC-catalog.md
 * marks these routes "Auth: Yes", but `AuthGuard` does not exist until Task 10
 * (identity is Phase 1), so for the Phase 0 walking skeleton they ship
 * unauthenticated. The guard is added here in Task 10 or Task 13.
 */
@Controller()
export class ReferenceController {
  constructor(private readonly referenceService: ReferenceService) {}

  @Get('currencies')
  listCurrencies(): Promise<CurrencyView[]> {
    return this.referenceService.listCurrencies();
  }

  @Get('exchanges')
  listExchanges(): Promise<ExchangeView[]> {
    return this.referenceService.listExchanges();
  }
}
