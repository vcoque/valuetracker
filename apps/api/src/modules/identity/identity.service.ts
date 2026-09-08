import {
  BadRequestException,
  ConflictException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../../shared/prisma/prisma.service';
import type {
  ClientTypeContract,
  LoginRequest,
  MeResponse,
  RegisterRequest,
  SessionSummary,
  UpdateMeRequest,
} from './dto/auth.dto';
import {
  hashPassword,
  PASSWORD_ALGORITHM,
  verifyPassword,
} from './domain/password';
import { generateRefreshToken, hashRefreshToken } from './domain/token';
import { TokenService } from './token.service';

/**
 * A real argon2id PHC string, produced once with the project's `HASH_OPTIONS`
 * (m=19456, t=2, p=1) over a throwaway value. Its only purpose: the login path
 * for an unknown email still runs one `verifyPassword` against *something*, so
 * "no such user" and "wrong password" do identical work and take
 * indistinguishable time (SPEC-identity.md AC). It hashes no real secret and
 * leaks nothing.
 *
 * Regenerate with:
 *   node -e "const {hash,Algorithm}=require('@node-rs/argon2'); \
 *     hash('...', {algorithm:Algorithm.Argon2id,memoryCost:19456,timeCost:2,parallelism:1}) \
 *     .then(console.log)"
 */
export const DUMMY_ARGON2ID_HASH =
  '$argon2id$v=19$m=19456,t=2,p=1$3FEGafhbaWHdP0z870J4yA$Ug4xLIj0eyjiRfN8yH++TJ5bN+B80chuRcbPzYVG3FQ';

/** Refresh-token lifetime: 30 days absolute, no sliding window (ADR 0003). */
export const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** The same generic 401 for every login failure -- no user enumeration. */
const INVALID_CREDENTIALS_MESSAGE = 'Invalid email or password';

/**
 * The one 401 for every `/auth/refresh` rejection -- unknown token, expired
 * session, revoked session, or a replayed (already-rotated) token. A caller
 * learns only "re-authenticate", never which case it hit.
 */
const REFRESH_REJECTED_MESSAGE = 'Invalid refresh token';

/** Shared by register's collision path and `PATCH /auth/me` -- an FK miss on
 * `base_currency_code` is a client error, not a server fault. */
const UNKNOWN_CURRENCY_MESSAGE = 'Unknown base currency code';

/** The generic 409 for a duplicate registration -- never echoes the email. */
const REGISTRATION_CONFLICT_MESSAGE = 'Registration could not be completed';

/** Per-request facts recorded on the session row. */
export interface SessionContext {
  readonly ip: string | null;
  readonly userAgent: string | null;
}

/**
 * The result of a successful register/login, before transport. The controller
 * decides -- from `clientType` -- whether the refresh token goes in a cookie
 * (WEB) or the response body (ANDROID).
 */
export interface IssuedSession {
  readonly accessToken: string;
  readonly expiresIn: number;
  readonly refreshToken: string;
  readonly refreshTokenExpiresAt: Date;
  readonly clientType: ClientTypeContract;
}

@Injectable()
export class IdentityService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tokens: TokenService,
  ) {}

  /**
   * Create a user + credential in one transaction and open a session.
   *
   * The password is hashed BEFORE the insert is attempted, so the success path
   * and the email-collision path each perform exactly one argon2id hash and
   * take indistinguishable time. A collision returns a generic 409 that never
   * says "email exists" and never echoes the address.
   *
   * Why this is not byte-identical to success: the brief requires register to
   * return real tokens, so a 200 with tokens cannot be faked for a collision.
   * `SPEC-identity.md`'s last AC sanctions the alternative -- "rate-limited hard
   * enough not to be a usable enumeration oracle". The per-IP limiter (tighter
   * on register than login), the generic body and the equal timing are the v1
   * mitigation; email verification is a tracked follow-up
   * (`SPEC-identity.md` §Open Questions).
   */
  async register(
    input: RegisterRequest,
    context: SessionContext,
  ): Promise<IssuedSession> {
    const { hash } = await hashPassword(input.password);

    let userId: string;
    try {
      const user = await this.prisma.$transaction(async (tx) => {
        const created = await tx.user.create({
          data: {
            email: input.email,
            displayName: input.displayName,
            baseCurrencyCode: input.baseCurrencyCode,
            timezone: input.timezone,
          },
          select: { id: true },
        });
        await tx.userCredential.create({
          data: {
            userId: created.id,
            passwordHash: hash,
            algorithm: PASSWORD_ALGORITHM,
          },
        });
        return created;
      });
      userId = user.id;
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError) {
        if (error.code === 'P2002') {
          throw new ConflictException({
            message: REGISTRATION_CONFLICT_MESSAGE,
          });
        }
        // The only foreign key a client controls on the user insert is
        // `base_currency_code` -> `currency.code`; `currencyCodeSchema` accepts
        // any AAA..ZZZ but only seeded codes exist. SPEC-identity.md AC:
        // "base_currency_code is validated against the currency table and
        // rejects unknown codes". A currency code is not user-identifying, so a
        // specific 400 leaks nothing.
        if (
          error.code === 'P2003' &&
          JSON.stringify(error.meta ?? {}).includes('base_currency_code')
        ) {
          throw new BadRequestException({
            message: UNKNOWN_CURRENCY_MESSAGE,
          });
        }
      }
      throw error;
    }

    return this.openSession(userId, input.clientType, context);
  }

  /**
   * Verify an email/password pair and open a session. An unknown email and a
   * wrong password return the SAME generic 401 and take the same time: the
   * lookup is followed by exactly one `verifyPassword`, against the stored hash
   * when there is one and against {@link DUMMY_ARGON2ID_HASH} when there is not
   * (SPEC-identity.md AC -- user enumeration through either channel is a defect).
   */
  async login(
    input: LoginRequest,
    context: SessionContext,
  ): Promise<IssuedSession> {
    const record = await this.prisma.user.findUnique({
      where: { email: input.email },
      select: { id: true, credential: { select: { passwordHash: true } } },
    });

    const storedHash = record?.credential?.passwordHash ?? DUMMY_ARGON2ID_HASH;
    const passwordMatches = await verifyPassword(input.password, storedHash);

    if (!record?.credential || !passwordMatches) {
      throw new UnauthorizedException({
        message: INVALID_CREDENTIALS_MESSAGE,
      });
    }

    return this.openSession(record.id, input.clientType, context);
  }

  /**
   * Open a `session` row (storing only `hashRefreshToken(raw)`) and mint the
   * access token. The raw refresh token is returned to the caller once, here,
   * and never persisted.
   */
  private async openSession(
    userId: string,
    clientType: ClientTypeContract,
    context: SessionContext,
  ): Promise<IssuedSession> {
    const rawRefreshToken = generateRefreshToken();
    const issuedAt = new Date();
    const expiresAt = new Date(issuedAt.getTime() + REFRESH_TOKEN_TTL_MS);

    const session = await this.prisma.session.create({
      data: {
        userId,
        tokenHash: hashRefreshToken(rawRefreshToken),
        clientType,
        issuedAt,
        expiresAt,
        userAgent: context.userAgent?.slice(0, 255) ?? null,
        ip: context.ip,
      },
      select: { id: true },
    });

    const access = await this.tokens.issueAccessToken({
      userId,
      sessionId: session.id,
    });

    return {
      accessToken: access.token,
      expiresIn: access.expiresIn,
      refreshToken: rawRefreshToken,
      refreshTokenExpiresAt: expiresAt,
      clientType,
    };
  }

  /**
   * Exchange a refresh token for a new access + refresh pair, rotating the
   * presented token (ADR 0003, `SPEC-identity.md` §Authentication Design).
   *
   * Rotation, in one transaction: a fresh `session` row is created (new token,
   * new hash, same `client_type`), and the presented row is marked
   * `revoked_at = now` with `replaced_by_id` pointing at the successor. The
   * conditional `updateMany` (`replacedById: null, revokedAt: null`) is what
   * makes two concurrent refreshes of the same token safe -- only one wins the
   * rotation; the loser's transaction rolls back and it gets a 401.
   *
   * **Reuse detection.** A token whose row already has `replaced_by_id` set has
   * been rotated before -- it should not exist on any client -- so presenting
   * it is treated as theft: every still-live session for that user is revoked
   * ("the entire chain for that user", `SPEC-identity.md`), forcing a full
   * re-authentication on every device. Returns the same generic 401.
   *
   * An unknown, expired or already-revoked token is a plain 401 with no side
   * effect.
   */
  async refresh(
    presentedToken: string,
    context: SessionContext,
  ): Promise<IssuedSession> {
    const session = await this.prisma.session.findUnique({
      where: { tokenHash: hashRefreshToken(presentedToken) },
      select: {
        id: true,
        userId: true,
        clientType: true,
        replacedById: true,
        revokedAt: true,
        expiresAt: true,
      },
    });

    if (!session) {
      throw new UnauthorizedException({ message: REFRESH_REJECTED_MESSAGE });
    }

    const now = new Date();

    if (session.replacedById !== null) {
      // Replay of a rotated token -> revoke the whole chain for this user.
      await this.prisma.$transaction([
        this.prisma.session.updateMany({
          where: { userId: session.userId, revokedAt: null },
          data: { revokedAt: now },
        }),
      ]);
      throw new UnauthorizedException({ message: REFRESH_REJECTED_MESSAGE });
    }

    if (session.revokedAt !== null || session.expiresAt <= now) {
      throw new UnauthorizedException({ message: REFRESH_REJECTED_MESSAGE });
    }

    const rawRefreshToken = generateRefreshToken();
    const expiresAt = new Date(now.getTime() + REFRESH_TOKEN_TTL_MS);

    const successor = await this.prisma.$transaction(async (tx) => {
      const created = await tx.session.create({
        data: {
          userId: session.userId,
          tokenHash: hashRefreshToken(rawRefreshToken),
          clientType: session.clientType,
          issuedAt: now,
          expiresAt,
          userAgent: context.userAgent?.slice(0, 255) ?? null,
          ip: context.ip,
        },
        select: { id: true },
      });

      const rotated = await tx.session.updateMany({
        where: { id: session.id, replacedById: null, revokedAt: null },
        data: { revokedAt: now, replacedById: created.id },
      });

      if (rotated.count !== 1) {
        // Lost a race with a concurrent refresh of the same token; roll back.
        throw new UnauthorizedException({ message: REFRESH_REJECTED_MESSAGE });
      }

      return created;
    });

    const access = await this.tokens.issueAccessToken({
      userId: session.userId,
      sessionId: successor.id,
    });

    return {
      accessToken: access.token,
      expiresIn: access.expiresIn,
      refreshToken: rawRefreshToken,
      refreshTokenExpiresAt: expiresAt,
      clientType: session.clientType,
    };
  }

  /** Revoke a single session (the caller's current one). Idempotent. */
  async logout(sessionId: string): Promise<void> {
    await this.prisma.session.updateMany({
      where: { id: sessionId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  /**
   * Revoke every still-live session for the user, not just the caller's
   * (`SPEC-identity.md` AC). A second device's refresh token stops working at
   * once; its access token lapses within 15 minutes.
   */
  async logoutAll(userId: string): Promise<void> {
    await this.prisma.session.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  /** The caller's own profile -- no hash, no tokens (`meResponseSchema`). */
  async getProfile(userId: string): Promise<MeResponse> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        displayName: true,
        baseCurrencyCode: true,
        timezone: true,
        createdAt: true,
      },
    });

    if (!user) {
      // A signed token for a user that no longer exists -- treat as unauthenticated.
      throw new UnauthorizedException({ message: 'Invalid access token' });
    }

    return { ...user, createdAt: user.createdAt.toISOString() };
  }

  /**
   * Update the three mutable profile fields. The schema (`updateMeRequestSchema`,
   * `.strict()`) has already rejected any other key with a 400; this only has to
   * turn an unknown `base_currency_code` (FK miss, `P2003`) into a 400 rather
   * than a 500, the same way `register` does.
   */
  async updateProfile(
    userId: string,
    patch: UpdateMeRequest,
  ): Promise<MeResponse> {
    try {
      const user = await this.prisma.user.update({
        where: { id: userId },
        data: {
          ...(patch.displayName !== undefined && {
            displayName: patch.displayName,
          }),
          ...(patch.baseCurrencyCode !== undefined && {
            baseCurrencyCode: patch.baseCurrencyCode,
          }),
          ...(patch.timezone !== undefined && { timezone: patch.timezone }),
        },
        select: {
          id: true,
          email: true,
          displayName: true,
          baseCurrencyCode: true,
          timezone: true,
          createdAt: true,
        },
      });

      return { ...user, createdAt: user.createdAt.toISOString() };
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError) {
        if (
          error.code === 'P2003' &&
          JSON.stringify(error.meta ?? {}).includes('base_currency_code')
        ) {
          throw new BadRequestException({ message: UNKNOWN_CURRENCY_MESSAGE });
        }
        if (error.code === 'P2025') {
          throw new UnauthorizedException({ message: 'Invalid access token' });
        }
      }
      throw error;
    }
  }

  /**
   * The user's active (non-revoked, non-expired) sessions for a "signed-in
   * devices" view. `current` marks the session the calling access token was
   * minted for.
   */
  async listSessions(
    userId: string,
    currentSessionId: string,
  ): Promise<SessionSummary[]> {
    const rows = await this.prisma.session.findMany({
      where: { userId, revokedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { issuedAt: 'desc' },
      select: {
        id: true,
        clientType: true,
        issuedAt: true,
        userAgent: true,
        ip: true,
      },
    });

    return rows.map((row) => ({
      id: row.id,
      clientType: row.clientType,
      issuedAt: row.issuedAt.toISOString(),
      lastUserAgent: row.userAgent,
      ip: row.ip,
      current: row.id === currentSessionId,
    }));
  }
}
