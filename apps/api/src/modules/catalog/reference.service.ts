import { Injectable } from '@nestjs/common';

import { PrismaService } from '../../shared/prisma/prisma.service';

/** A currency as returned by `GET /currencies`. */
export interface CurrencyView {
  readonly code: string;
  readonly name: string;
  readonly symbol: string | null;
  readonly minorUnit: number;
}

/** An exchange as returned by `GET /exchanges`. */
export interface ExchangeView {
  readonly code: string;
  readonly name: string;
  readonly countryCode: string;
  readonly currencyCode: string;
  readonly timezone: string;
}

/**
 * Read-only access to the seeded reference tables. There is no write path: the
 * rows come from `prisma/seed.ts` and, later, `market-data` ingestion -- never
 * from an API client.
 */
@Injectable()
export class ReferenceService {
  constructor(private readonly prisma: PrismaService) {}

  async listCurrencies(): Promise<CurrencyView[]> {
    return this.prisma.currency.findMany({
      orderBy: { code: 'asc' },
      select: { code: true, name: true, symbol: true, minorUnit: true },
    });
  }

  async listExchanges(): Promise<ExchangeView[]> {
    return this.prisma.exchange.findMany({
      orderBy: { code: 'asc' },
      select: {
        code: true,
        name: true,
        countryCode: true,
        currencyCode: true,
        timezone: true,
      },
    });
  }
}
