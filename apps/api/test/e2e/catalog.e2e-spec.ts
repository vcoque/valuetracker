import { Test } from '@nestjs/testing';
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import request from 'supertest';

import { seedReferenceData } from '../../prisma/seed';
import { AppModule } from '../../src/app.module';
import { PrismaService } from '../../src/shared/prisma/prisma.service';

/**
 * The plan's acceptance criterion: `GET /currencies` and `GET /exchanges`
 * return the seeded reference data, over the full HTTP stack and a real
 * database. The rows come from the same `seedReferenceData` that `prisma db
 * seed` runs; `integration-setup.ts` truncates between tests, so it runs before
 * each one.
 */
describe('catalog reference endpoints (e2e)', () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter(),
    );
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await seedReferenceData(app.get(PrismaService));
  });

  it('GET /currencies returns the seeded currencies', async () => {
    const response = await request(app.getHttpServer()).get('/currencies');

    expect(response.status).toBe(200);
    expect(response.body).toEqual([
      { code: 'BRL', name: 'Brazilian Real', symbol: 'R$', minorUnit: 2 },
      { code: 'EUR', name: 'Euro', symbol: '€', minorUnit: 2 },
      { code: 'USD', name: 'US Dollar', symbol: '$', minorUnit: 2 },
    ]);
  });

  it('GET /exchanges returns the seeded exchanges', async () => {
    const response = await request(app.getHttpServer()).get('/exchanges');

    expect(response.status).toBe(200);
    expect(response.body).toEqual([
      {
        code: 'B3',
        name: 'B3 - Brasil, Bolsa, Balcão',
        countryCode: 'BR',
        currencyCode: 'BRL',
        timezone: 'America/Sao_Paulo',
      },
    ]);
  });
});
