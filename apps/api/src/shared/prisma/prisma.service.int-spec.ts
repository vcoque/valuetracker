import { Test, type TestingModule } from '@nestjs/testing';

import { PrismaModule } from './prisma.module';
import { PrismaService } from './prisma.service';

/**
 * Proves the harness itself: a real PostgreSQL, the committed migrations
 * applied to it, and a clean slate for every test.
 *
 * Nothing here overrides configuration. `global-setup.ts` puts the throwaway
 * container's URL in DATABASE_URL, so the application's own ConfigModule
 * resolves it exactly as it would in production -- which means this also tests
 * the configuration path, not just the query path.
 */
describe('PrismaService (integration)', () => {
  let moduleRef: TestingModule;
  let prisma: PrismaService;

  beforeEach(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [PrismaModule],
    }).compile();

    // init() is what triggers onModuleInit, so a broken $connect fails here.
    await moduleRef.init();
    prisma = moduleRef.get(PrismaService);
  });

  afterEach(async () => {
    await moduleRef.close();
  });

  it('writes a row and reads it back', async () => {
    await prisma.currency.create({
      data: { code: 'BRL', name: 'Brazilian Real', symbol: 'R$', minorUnit: 2 },
    });

    const found = await prisma.currency.findUnique({ where: { code: 'BRL' } });

    expect(found).toEqual({
      code: 'BRL',
      name: 'Brazilian Real',
      symbol: 'R$',
      minorUnit: 2,
    });
  });

  it('persists an optional column as null when it is absent', async () => {
    await prisma.currency.create({
      data: { code: 'XAU', name: 'Gold', minorUnit: 0 },
    });

    const found = await prisma.currency.findUnique({ where: { code: 'XAU' } });

    expect(found?.symbol).toBeNull();
  });

  it('starts from an empty database, despite the rows the tests above wrote', async () => {
    // The assertion is about the harness, not about `currency`: if truncation
    // between tests ever stops working, this is the test that says so, and it
    // says so before a downstream suite starts passing for the wrong reason.
    await expect(prisma.currency.count()).resolves.toBe(0);
  });

  it('applied the committed migrations rather than pushing the schema', async () => {
    const applied = await prisma.$queryRaw<{ migration_name: string }[]>`
      SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL
    `;

    expect(applied.length).toBeGreaterThan(0);
    expect(
      applied.some((row) => row.migration_name.endsWith('init_currency')),
    ).toBe(true);
  });
});

// Both tests below manage their own module -- closing it is the assertion
// itself, so neither uses the `beforeEach`/`afterEach` pair above. Sharing
// that pair would double-close the module: harmless to the assertion, since
// it already ran, but it hides which close() the test is actually about.
describe('PrismaService lifecycle (integration)', () => {
  it('connects eagerly on module init, not lazily on first query', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [PrismaModule],
    }).compile();

    const prisma = moduleRef.get(PrismaService);
    const connect = jest.spyOn(prisma, '$connect');

    expect(connect).not.toHaveBeenCalled();

    await moduleRef.init();

    // The distinction matters on deploy: connecting here turns a bad connection
    // string into a container that refuses to start, rather than into a healthy
    // container that fails every request.
    expect(connect).toHaveBeenCalledTimes(1);

    await moduleRef.close();
  });

  it('disconnects when the module is destroyed', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [PrismaModule],
    }).compile();

    await moduleRef.init();
    const prisma = moduleRef.get(PrismaService);

    // Asserting on the lifecycle call rather than on a failing query, because
    // $disconnect() only releases the pool -- Prisma reconnects on the next
    // query, so "a query afterwards throws" is not true and never was. What
    // matters here is that Nest's shutdown actually reaches the service, which
    // it only does because main.ts calls enableShutdownHooks().
    const disconnect = jest.spyOn(prisma, '$disconnect');

    await moduleRef.close();

    expect(disconnect).toHaveBeenCalledTimes(1);
  });
});
