import { Test } from '@nestjs/testing';
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import request from 'supertest';

import { AppModule } from '../../src/app.module';

/**
 * The e2e project's smoke test. `/health` needs no database, which makes it the
 * one endpoint that can prove the HTTP stack -- Fastify adapter, routing,
 * serialization -- before Prisma exists.
 */
describe('GET /health (e2e)', () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter(),
    );
    await app.init();
    // Fastify builds its router lazily. Without this the first request can
    // arrive before the routes are registered, which fails as a 404 that looks
    // like a routing bug.
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('answers 200 with the health report', async () => {
    const response = await request(app.getHttpServer()).get('/health');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'ok' });
  });
});
