import {
  Injectable,
  Logger,
  type OnModuleInit,
  UnauthorizedException,
} from '@nestjs/common';
import {
  type CryptoKey,
  type JWK,
  type KeyObject,
  SignJWT,
  calculateJwkThumbprint,
  exportJWK,
  generateKeyPair,
  importJWK,
  importPKCS8,
  jwtVerify,
} from 'jose';

type SigningKey = CryptoKey | KeyObject;

import { AppConfig } from '../../shared/config/app-config';
import {
  ACCESS_TOKEN_TTL_SECONDS,
  buildAccessTokenClaims,
} from './domain/access-token';

/** EdDSA over Ed25519 (ADR 0003). The one signing algorithm this service uses. */
const SIGNING_ALG = 'EdDSA';

export interface IssuedAccessToken {
  /** The compact-serialised, signed JWT. */
  readonly token: string;
  /** Lifetime in seconds (900), for the `expiresIn` response field. */
  readonly expiresIn: number;
}

export interface IssueAccessTokenInput {
  readonly userId: string;
  readonly sessionId: string;
}

/** What a verified access token yields: the two identifier claims, nothing else. */
export interface VerifiedAccessToken {
  /** `sub` -- the user id. */
  readonly sub: string;
  /** `sid` -- the session id. */
  readonly sid: string;
}

/**
 * The slice of `TokenService` that `AuthGuard` -- and any other module's
 * guard -- depends on: verification only, never issuance. `IdentityModule`
 * binds {@link ACCESS_TOKEN_VERIFIER} to the `TokenService` singleton and
 * exports *that token*, so a consumer module can resolve the guard without
 * `issueAccessToken` leaking outside `identity`.
 */
export interface AccessTokenVerifier {
  verifyAccessToken(token: string): Promise<VerifiedAccessToken>;
}

/** DI token for {@link AccessTokenVerifier}. */
export const ACCESS_TOKEN_VERIFIER = Symbol('ACCESS_TOKEN_VERIFIER');

/**
 * Mints EdDSA access tokens and owns the signing key.
 *
 * Key precedence (ADR 0003, task-9b context):
 *  1. `JWT_PRIVATE_KEY` set  -> import it (base64 PKCS#8 PEM, Ed25519).
 *  2. unset and not production -> generate an ephemeral keypair at startup and
 *     log a warning; tokens do not survive a restart, which is fine for dev/test.
 *  3. unset and production -> refuse to boot. A production service signing with
 *     a key that changes on every deploy would invalidate every live token on
 *     each rollout and make horizontal scaling impossible.
 *
 * `kid` is the RFC 7638 JWK thumbprint of the public key, so a future JWKS
 * endpoint / key rotation (Task 10+) can publish the matching verification key
 * under the same identifier.
 */
@Injectable()
export class TokenService implements OnModuleInit, AccessTokenVerifier {
  private readonly logger = new Logger(TokenService.name);

  private signingKey!: SigningKey;
  private verificationKey!: SigningKey;
  private kid!: string;
  private publicJwk!: JWK;

  constructor(private readonly config: AppConfig) {}

  async onModuleInit(): Promise<void> {
    const privateKey = await this.resolveSigningKey();
    this.signingKey = privateKey;

    // Derive the public JWK from the private key so the thumbprint is stable
    // whichever branch produced the key. `calculateJwkThumbprint` uses only the
    // RFC 7638 required members (`kty`, `crv`, `x` for OKP).
    const jwk = await exportJWK(privateKey);
    const { d: _private, ...publicJwk } = jwk;
    this.publicJwk = publicJwk;
    this.kid = await calculateJwkThumbprint(publicJwk);

    // Import the public key once, here, so `verifyAccessToken` on the request
    // path is a pure signature check with no per-call key parsing.
    this.verificationKey = (await importJWK(
      publicJwk,
      SIGNING_ALG,
    )) as SigningKey;
  }

  private async resolveSigningKey(): Promise<SigningKey> {
    if (this.config.jwtPrivateKey) {
      const pem = Buffer.from(this.config.jwtPrivateKey, 'base64').toString(
        'utf8',
      );
      try {
        return await importPKCS8(pem, SIGNING_ALG, { extractable: true });
      } catch {
        // Swallow jose's parse error -- it can quote the surrounding key
        // material into the boot log. A static message is enough to act on.
        throw new Error(
          'JWT_PRIVATE_KEY is not a valid base64-encoded PKCS#8 Ed25519 private key',
        );
      }
    }

    if (this.config.nodeEnv === 'production') {
      throw new Error(
        'JWT_PRIVATE_KEY is required in production: an ephemeral key would ' +
          'invalidate every live token on each deploy and cannot be shared ' +
          'across instances.',
      );
    }

    this.logger.warn(
      'JWT_PRIVATE_KEY not set - generating an ephemeral Ed25519 keypair. ' +
        "Access tokens will not survive a restart. Set JWT_PRIVATE_KEY for a " +
        'stable signing key.',
    );
    const { privateKey } = await generateKeyPair(SIGNING_ALG, {
      extractable: true,
    });
    return privateKey;
  }

  /**
   * Sign an access token for a freshly opened session. The claim object comes
   * from {@link buildAccessTokenClaims} and is signed verbatim -- no `jose`
   * claim helpers are called, so the token carries exactly those six claims.
   */
  async issueAccessToken(
    input: IssueAccessTokenInput,
  ): Promise<IssuedAccessToken> {
    const claims = buildAccessTokenClaims({
      userId: input.userId,
      sessionId: input.sessionId,
      issuer: this.config.jwtIssuer,
      audience: this.config.jwtAudience,
    });

    const token = await new SignJWT({ ...claims })
      .setProtectedHeader({ alg: SIGNING_ALG, kid: this.kid })
      .sign(this.signingKey);

    return { token, expiresIn: ACCESS_TOKEN_TTL_SECONDS };
  }

  /**
   * The public verification key as a JWK, plus its `kid`. Task 10's `AuthGuard`
   * and any JWKS endpoint verify against this; exposed here so tests can check a
   * signature without reaching into the private field.
   */
  getPublicJwk(): { kid: string; jwk: JWK } {
    return { kid: this.kid, jwk: this.publicJwk };
  }

  /**
   * Verify a Bearer access token and return its `sub` / `sid`. Used by
   * `AuthGuard` on every authenticated request.
   *
   * The algorithm is pinned to a one-entry allow-list (`['EdDSA']`) and the
   * token's own `alg` header is NEVER consulted -- this is what defeats an
   * `alg: none` forgery and an algorithm-confusion downgrade. `iss` and `aud`
   * are checked so a token minted for another deployment does not verify here,
   * and `exp` is enforced by `jwtVerify`. `kid` must name the current signing
   * key: with a single key that makes an unknown-`kid` token an explicit
   * reject; when key rotation lands this becomes a JWKS lookup over several
   * valid `kid`s.
   *
   * Every failure mode -- malformed input, bad signature, `alg: none`, unknown
   * `kid`, wrong `iss`/`aud`, expiry, a payload missing `sub`/`sid` -- is
   * funnelled into a single {@link UnauthorizedException}. No `jose` error is
   * allowed to propagate: unwrapped it would surface as a 500, and its message
   * can quote token bytes into a log line.
   */
  async verifyAccessToken(token: string): Promise<VerifiedAccessToken> {
    try {
      const { payload, protectedHeader } = await jwtVerify(
        token,
        this.verificationKey,
        {
          algorithms: [SIGNING_ALG],
          issuer: this.config.jwtIssuer,
          audience: this.config.jwtAudience,
        },
      );

      if (protectedHeader.kid !== this.kid) {
        throw new UnauthorizedException({ message: 'Invalid access token' });
      }

      const { sub, sid } = payload;
      if (
        typeof sub !== 'string' ||
        sub.length === 0 ||
        typeof sid !== 'string' ||
        sid.length === 0
      ) {
        throw new UnauthorizedException({ message: 'Invalid access token' });
      }

      return { sub, sid };
    } catch (error) {
      if (error instanceof UnauthorizedException) {
        throw error;
      }
      // The error CLASS only -- never `error.message`, which can quote token
      // bytes into the log. Enough to tell an `alg:none` reject from a
      // key-loading bug that would otherwise be an invisible 401.
      this.logger.debug(
        `access token rejected: ${
          error instanceof Error ? error.constructor.name : typeof error
        }`,
      );
      throw new UnauthorizedException({ message: 'Invalid access token' });
    }
  }
}
