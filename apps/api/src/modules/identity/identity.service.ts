import {
  BadRequestException,
  ConflictException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../../shared/prisma/prisma.service';
import type { ClientTypeContract, LoginRequest, RegisterRequest } from './dto/auth.dto';
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
            message: 'Unknown base currency code',
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
}
