import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import {
  type CryptoKey,
  type JWK,
  type KeyObject,
  SignJWT,
  calculateJwkThumbprint,
  exportJWK,
  generateKeyPair,
  importPKCS8,
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
export class TokenService implements OnModuleInit {
  private readonly logger = new Logger(TokenService.name);

  private signingKey!: SigningKey;
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
  }

  private async resolveSigningKey(): Promise<SigningKey> {
    if (this.config.jwtPrivateKey) {
      const pem = Buffer.from(this.config.jwtPrivateKey, 'base64').toString(
        'utf8',
      );
      return importPKCS8(pem, SIGNING_ALG, { extractable: true });
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
}
