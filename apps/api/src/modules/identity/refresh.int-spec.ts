import { UnauthorizedException } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';

import { ConfigModule } from '../../shared/config/config.module';
import { PrismaModule } from '../../shared/prisma/prisma.module';
import { PrismaService } from '../../shared/prisma/prisma.service';
import { generateRefreshToken, hashRefreshToken } from './domain/token';
import { IdentityService, REFRESH_TOKEN_TTL_MS } from './identity.service';
import { TokenService } from './token.service';

/**
 * `/auth/refresh` rotation and reuse detection against a real database
 * (`SPEC-identity.md` §Authentication Design, ADR 0003). The HTTP layer is out
 * of scope here -- this drives `IdentityService.refresh` directly so the
 * rotation-chain state can be read straight out of the `session` table.
 *
 * Acceptance criteria exercised:
 *  - a valid refresh rotates: the presented row gets `revoked_at` + a
 *    `replaced_by_id` pointing at its successor, and a new pair is issued;
 *  - reuse detection: replaying an already-rotated token revokes EVERY live
 *    session for that user (the whole chain), and returns 401;
 *  - an unknown / expired token is a 401 with no side effect.
 */
describe('identity refresh + rotation (integration)', () => {
  let moduleRef: TestingModule;
  let prisma: PrismaService;
  let identity: IdentityService;

  const context = { ip: '203.0.113.20', userAgent: 'jest-refresh' };

  const registerAndroid = (
    email: string,
  ): ReturnType<IdentityService['register']> =>
    identity.register(
      {
        email,
        password: 'a-sufficiently-long-password',
        displayName: 'Refresh Person',
        baseCurrencyCode: 'BRL',
        timezone: 'UTC',
        clientType: 'ANDROID',
      },
      context,
    );

  const liveSessionCount = (userId: string): Promise<number> =>
    prisma.session.count({ where: { userId, revokedAt: null } });

  beforeEach(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [PrismaModule, ConfigModule],
      providers: [IdentityService, TokenService],
    }).compile();
    await moduleRef.init();

    prisma = moduleRef.get(PrismaService);
    identity = moduleRef.get(IdentityService);

    await prisma.currency.create({
      data: { code: 'BRL', name: 'Brazilian Real', symbol: 'R$', minorUnit: 2 },
    });
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await moduleRef.close();
  });

  it('rotates a valid refresh token: old row revoked and linked to its successor', async () => {
    const issued = await registerAndroid('rotate@example.com');
    const original = await prisma.session.findUniqueOrThrow({
      where: { tokenHash: hashRefreshToken(issued.refreshToken) },
    });

    const rotated = await identity.refresh(issued.refreshToken, context);

    expect(rotated.refreshToken).not.toBe(issued.refreshToken);
    expect(rotated.accessToken).not.toBe(issued.accessToken);
    expect(rotated.clientType).toBe('ANDROID');

    const oldRow = await prisma.session.findUniqueOrThrow({
      where: { id: original.id },
    });
    const newRow = await prisma.session.findUniqueOrThrow({
      where: { tokenHash: hashRefreshToken(rotated.refreshToken) },
    });

    expect(oldRow.revokedAt).not.toBeNull();
    expect(oldRow.replacedById).toBe(newRow.id);
    expect(newRow.revokedAt).toBeNull();
    expect(newRow.replacedById).toBeNull();
    expect(newRow.userId).toBe(original.userId);
  });

  it('accepts the new token and rejects the old one after a rotation', async () => {
    const issued = await registerAndroid('roundtrip@example.com');

    // Rotate A -> B, then confirm B works (B -> C) BEFORE replaying A. Replaying
    // a rotated token is reuse and kills the whole chain, so the "new one works"
    // check has to come first.
    const rotated = await identity.refresh(issued.refreshToken, context);
    await expect(
      identity.refresh(rotated.refreshToken, context),
    ).resolves.toMatchObject({ clientType: 'ANDROID' });

    await expect(
      identity.refresh(issued.refreshToken, context),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('reuse detection: replaying a rotated token revokes every session for the user', async () => {
    const issued = await registerAndroid('reuse@example.com');
    const { userId } = await prisma.session.findUniqueOrThrow({
      where: { tokenHash: hashRefreshToken(issued.refreshToken) },
    });

    // First rotation: token A -> token B. A's row is now revoked+replaced; B is live.
    const rotated = await identity.refresh(issued.refreshToken, context);
    expect(await liveSessionCount(userId)).toBe(1);

    // Replay the already-rotated token A.
    let thrown: unknown;
    try {
      await identity.refresh(issued.refreshToken, context);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(UnauthorizedException);
    expect((thrown as UnauthorizedException).getStatus()).toBe(401);

    // The whole chain for this user is dead -- B included.
    expect(await liveSessionCount(userId)).toBe(0);
    const rows = await prisma.session.findMany({ where: { userId } });
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.revokedAt !== null)).toBe(true);

    // And token B no longer works.
    await expect(
      identity.refresh(rotated.refreshToken, context),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects an unknown refresh token with 401 and no write', async () => {
    const issued = await registerAndroid('unknown@example.com');
    const before = await prisma.session.findMany();

    await expect(
      identity.refresh(generateRefreshToken(), context),
    ).rejects.toBeInstanceOf(UnauthorizedException);

    const after = await prisma.session.findMany();
    expect(after).toEqual(before);
    expect(issued.refreshToken).toBeDefined();
  });

  it('rejects an expired session with 401', async () => {
    const issued = await registerAndroid('expired@example.com');
    await prisma.session.update({
      where: { tokenHash: hashRefreshToken(issued.refreshToken) },
      data: {
        issuedAt: new Date(Date.now() - REFRESH_TOKEN_TTL_MS - 1000),
        expiresAt: new Date(Date.now() - 1000),
      },
    });

    await expect(
      identity.refresh(issued.refreshToken, context),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  /**
   * F10.2 -- post-commit ordering, distinct from a concurrent (in-flight) race.
   * A client completes one refresh, its response is lost on a flaky network, and
   * it retries with the SAME (now-rotated) token. The retry's `findUnique` runs
   * AFTER the first refresh committed, so it lands on the `replacedById !== null`
   * branch and revokes EVERY live session for the user -- here, three devices.
   *
   * This is the behaviour `SPEC-identity.md` mandates ("replaying an
   * already-rotated token revokes the whole chain"). The blast radius and the
   * standard grace-window mitigation are documented in ADR 0003 under
   * "Reuse detection: strictness vs. client retries"; the mitigation is deferred
   * pending an owner decision and is NOT implemented.
   */
  it('post-commit replay (a lost-response retry) logs the user out on every device', async () => {
    const issued = await registerAndroid('retry@example.com');
    const { userId } = await prisma.session.findUniqueOrThrow({
      where: { tokenHash: hashRefreshToken(issued.refreshToken) },
    });
    // Two more logged-in devices.
    await identity.login(
      { email: 'retry@example.com', password: 'a-sufficiently-long-password', clientType: 'ANDROID' },
      context,
    );
    await identity.login(
      { email: 'retry@example.com', password: 'a-sufficiently-long-password', clientType: 'ANDROID' },
      context,
    );
    expect(await liveSessionCount(userId)).toBe(3);

    // A normal refresh runs to completion (its response is then "lost").
    await identity.refresh(issued.refreshToken, context);
    expect(await liveSessionCount(userId)).toBe(3); // 2 untouched + 1 successor

    // The client retries with the same token it already spent.
    await expect(
      identity.refresh(issued.refreshToken, context),
    ).rejects.toBeInstanceOf(UnauthorizedException);

    // Every session for the user is now revoked -- the two bystander devices too.
    expect(await liveSessionCount(userId)).toBe(0);
    const rows = await prisma.session.findMany({ where: { userId } });
    expect(rows.every((row) => row.revokedAt !== null)).toBe(true);
  });

  /**
   * F10.3 -- the rotation transaction rolls back cleanly. A concurrent actor
   * revokes the presented row AFTER `refresh()` has read it but BEFORE the
   * conditional `updateMany`, so that update matches zero rows, the `count !== 1`
   * guard throws inside the `$transaction`, and the speculatively-created
   * successor must not survive.
   */
  it('rolls the rotation back with no orphan successor when the conditional update matches nothing', async () => {
    const issued = await registerAndroid('rollback@example.com');
    const original = await prisma.session.findUniqueOrThrow({
      where: { tokenHash: hashRefreshToken(issued.refreshToken) },
    });
    const before = await prisma.session.count({
      where: { userId: original.userId },
    });

    const realFindUnique = prisma.session.findUnique.bind(
      prisma.session,
    ) as (args: unknown) => Promise<unknown>;
    jest.spyOn(prisma.session, 'findUnique').mockImplementationOnce(((
      args: unknown,
    ) =>
      realFindUnique(args).then(async (found) => {
        await prisma.session.update({
          where: { id: original.id },
          data: { revokedAt: new Date() },
        });
        return found;
      })) as unknown as typeof prisma.session.findUnique);

    await expect(
      identity.refresh(issued.refreshToken, context),
    ).rejects.toBeInstanceOf(UnauthorizedException);

    // No new row persisted: the successor create was rolled back with the txn.
    const after = await prisma.session.count({
      where: { userId: original.userId },
    });
    expect(after).toBe(before);
    expect(
      await prisma.session.findFirst({
        where: { userId: original.userId, revokedAt: null },
      }),
    ).toBeNull();
  });
});
