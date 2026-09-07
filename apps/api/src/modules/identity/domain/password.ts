import { Algorithm, hash, verify } from '@node-rs/argon2';

/**
 * Password hashing (SPEC-identity.md AC: "Passwords are hashed with argon2id").
 *
 * Pure domain code: no database, no `@nestjs/*`, no logging. The only dependency
 * is the argon2 implementation itself. `@node-rs/argon2` is a prebuilt native
 * addon (no node-gyp compile at install), chosen for container reliability --
 * see docs/adr/0006-password-hashing.md.
 */

/**
 * Recorded in `user_credential.algorithm` next to every hash, so a stored hash
 * can be identified and upgraded in place when the parameters below change
 * (SPEC-identity.md §user_credential).
 */
export const PASSWORD_ALGORITHM = 'argon2id';

/**
 * argon2id cost parameters. These are the OWASP Password Storage Cheat Sheet
 * minimum for argon2id (19 MiB memory, 2 passes, 1 lane) and also
 * `@node-rs/argon2`'s own defaults; they are pinned explicitly here so a change
 * in the library's defaults cannot silently move the project's security bar.
 * The encoded hash carries these values, so `verify` needs no matching config.
 */
const HASH_OPTIONS = {
  algorithm: Algorithm.Argon2id,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;

/**
 * Hash a plaintext password. Returns the PHC-format encoded hash (algorithm,
 * version, parameters and salt all embedded) and the algorithm name to store
 * alongside it. A fresh random salt is generated per call, so hashing the same
 * password twice yields different strings.
 */
export async function hashPassword(
  plain: string,
): Promise<{ hash: string; algorithm: string }> {
  return {
    hash: await hash(plain, HASH_OPTIONS),
    algorithm: PASSWORD_ALGORITHM,
  };
}

/**
 * Check a plaintext password against a stored hash. Returns `false` -- never
 * throws -- for a non-matching password or a malformed/unrecognised hash, so a
 * caller can treat "wrong password" and "corrupt stored hash" the same way
 * without a try/catch of its own.
 */
export async function verifyPassword(
  plain: string,
  storedHash: string,
): Promise<boolean> {
  try {
    return await verify(storedHash, plain);
  } catch {
    return false;
  }
}
