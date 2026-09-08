import { Controller, Get, UseGuards } from '@nestjs/common';

import { AuthGuard } from '../identity/auth.guard';
import {
  type CurrencyView,
  type ExchangeView,
  ReferenceService,
} from './reference.service';

/**
 * Reference-data endpoints for the `catalog` module: the currencies and
 * exchanges everything else is denominated in and traded on.
 *
 * `SPEC-catalog.md` §API Surface marks both routes "Auth: Yes" (Ruling S4):
 * every read is scoped to an authenticated caller. `AuthGuard` comes from
 * `IdentityModule`, which `CatalogModule` imports.
 */
@Controller()
@UseGuards(AuthGuard)
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
