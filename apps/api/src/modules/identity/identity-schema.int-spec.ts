import { randomUUID } from 'node:crypto';

import { Test, type TestingModule } from '@nestjs/testing';

import { foreignKeyViolation, uniqueViolation } from '../../../test/pg-error';
import { PrismaModule } from '../../shared/prisma/prisma.module';
import { PrismaService } from '../../shared/prisma/prisma.service';

/**
 * Structural invariants owned by the `identity` tables, asserted at the database
 * rather than through the ORM (`SPEC.md` §Testing Strategy: the database must
 * reject the violation, not merely the service). Each write below is raw SQL, so
 * a passing test proves PostgreSQL enforces the constraint.
 *
 * `SPEC-identity.md` acceptance criteria exercised here:
 *  - email uniqueness is a database constraint, "proven by a duplicate insert";
 *  - the refresh-token hash is unique;
 *  - `base_currency_code` rejects unknown currency codes;
 *  - the password hash is never selectable through a `user` read.
 */
describe('identity schema (integration)', () => {
  let moduleRef: TestingModule;
  let prisma: PrismaService;

  const currencyCode = 'BRL';

  beforeEach(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [PrismaModule],
    }).compile();
    await moduleRef.init();
    prisma = moduleRef.get(PrismaService);

    // Each integration test starts from an empty database; `user.base_currency_code`
    // needs a real `currency` row to point at.
    await prisma.currency.create({
      data: { code: currencyCode, name: 'Brazilian Real', symbol: 'R$', minorUnit: 2 },
    });
  });

  afterEach(async () => {
    await moduleRef.close();
  });

  async function createUser(email: string): Promise<{ id: string }> {
    return prisma.user.create({
      data: {
        email,
        displayName: 'Test User',
        baseCurrencyCode: currencyCode,
        timezone: 'America/Sao_Paulo',
      },
      select: { id: true },
    });
  }

  it('rejects a second user with a duplicate email (unique constraint, 23505)', async () => {
    await createUser('dup@example.com');

    const second = prisma.$executeRawUnsafe(
      `INSERT INTO "user" ("email", "display_name", "base_currency_code", "timezone", "updated_at")
       VALUES ('dup@example.com', 'Other', '${currencyCode}', 'Etc/UTC', now())`,
    );

    await expect(second).rejects.toMatchObject(uniqueViolation);
  });

  it('rejects a user whose base_currency_code has no currency row (FK, 23503)', async () => {
    const insert = prisma.$executeRawUnsafe(
      `INSERT INTO "user" ("email", "display_name", "base_currency_code", "timezone", "updated_at")
       VALUES ('nocurrency@example.com', 'Test User', 'ZZZ', 'Etc/UTC', now())`,
    );

    await expect(insert).rejects.toMatchObject(foreignKeyViolation);
  });

  it('rejects a second session with a duplicate token_hash (unique constraint, 23505)', async () => {
    const user = await createUser('sessions@example.com');
    const tokenHash = 'a'.repeat(64);

    await prisma.session.create({
      data: {
        userId: user.id,
        tokenHash,
        clientType: 'WEB',
        expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      },
    });

    const second = prisma.$executeRawUnsafe(
      `INSERT INTO "session" ("user_id", "token_hash", "client_type", "expires_at")
       VALUES ('${user.id}', '${tokenHash}', 'ANDROID', now() + interval '30 days')`,
    );

    await expect(second).rejects.toMatchObject(uniqueViolation);
  });

  it('rejects a user_credential for a non-existent user (FK, 23503)', async () => {
    const insert = prisma.$executeRawUnsafe(
      `INSERT INTO "user_credential" ("user_id", "password_hash", "algorithm", "updated_at")
       VALUES ('${randomUUID()}', '$argon2id$fake', 'argon2id', now())`,
    );

    await expect(insert).rejects.toMatchObject(foreignKeyViolation);
  });

  it('rejects a second user_credential row for one user (primary key, 23505)', async () => {
    const user = await createUser('onecred@example.com');

    await prisma.userCredential.create({
      data: { userId: user.id, passwordHash: '$argon2id$one', algorithm: 'argon2id' },
    });

    const second = prisma.$executeRawUnsafe(
      `INSERT INTO "user_credential" ("user_id", "password_hash", "algorithm", "updated_at")
       VALUES ('${user.id}', '$argon2id$two', 'argon2id', now())`,
    );

    await expect(second).rejects.toMatchObject(uniqueViolation);
  });

  it('rejects a session whose replaced_by_id points at no session (self-FK, 23503)', async () => {
    const user = await createUser('rotation@example.com');

    const insert = prisma.$executeRawUnsafe(
      `INSERT INTO "session" ("user_id", "token_hash", "client_type", "expires_at", "replaced_by_id")
       VALUES ('${user.id}', '${'b'.repeat(64)}', 'WEB', now() + interval '30 days', '${randomUUID()}')`,
    );

    await expect(insert).rejects.toMatchObject(foreignKeyViolation);
  });

  it('never exposes the password hash through a plain user read', async () => {
    const user = await createUser('hidden@example.com');
    await prisma.userCredential.create({
      data: {
        userId: user.id,
        passwordHash: '$argon2id$v=19$m=19456,t=2,p=1$abc$def',
        algorithm: 'argon2id',
      },
    });

    const found = await prisma.user.findUnique({ where: { id: user.id } });

    expect(found).not.toBeNull();
    expect(Object.keys(found ?? {}).sort()).toEqual([
      'baseCurrencyCode',
      'createdAt',
      'displayName',
      'email',
      'id',
      'timezone',
      'updatedAt',
    ]);
    expect(found).not.toHaveProperty('passwordHash');
    expect(found).not.toHaveProperty('credential');

    // The hash is still reachable, but only by asking for it explicitly.
    const withCredential = await prisma.user.findUnique({
      where: { id: user.id },
      include: { credential: true },
    });
    expect(withCredential?.credential?.passwordHash).toBe(
      '$argon2id$v=19$m=19456,t=2,p=1$abc$def',
    );
  });

  it('migrated the documented columns and nullability for the identity tables', async () => {
    const columns = await prisma.$queryRawUnsafe<
      { table_name: string; column_name: string; is_nullable: string }[]
    >(
      `SELECT table_name, column_name, is_nullable
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name IN ('user', 'user_credential', 'session')
       ORDER BY table_name, column_name`,
    );

    const shape = columns.map(
      (c) => `${c.table_name}.${c.column_name}:${c.is_nullable}`,
    );

    expect(shape).toEqual([
      'session.client_type:NO',
      'session.expires_at:NO',
      'session.id:NO',
      'session.ip:YES',
      'session.issued_at:NO',
      'session.replaced_by_id:YES',
      'session.revoked_at:YES',
      'session.token_hash:NO',
      'session.user_agent:YES',
      'session.user_id:NO',
      'user.base_currency_code:NO',
      'user.created_at:NO',
      'user.display_name:NO',
      'user.email:NO',
      'user.id:NO',
      'user.timezone:NO',
      'user.updated_at:NO',
      'user_credential.algorithm:NO',
      'user_credential.password_hash:NO',
      'user_credential.updated_at:NO',
      'user_credential.user_id:NO',
    ]);
  });
});
