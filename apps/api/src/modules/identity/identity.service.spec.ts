import { hashPassword } from './domain/password';
import { DUMMY_ARGON2ID_HASH } from './identity.service';

/**
 * The timing-equalisation dummy hash must stay parameter-matched to the real
 * ones. If `HASH_OPTIONS` in `domain/password.ts` is raised later (a bigger
 * memory or time cost), a stale cheaper dummy would make the unknown-email
 * login path finish sooner than the wrong-password path and reopen the
 * enumeration timing gap this constant exists to close.
 */
describe('DUMMY_ARGON2ID_HASH', () => {
  const phcParams = (hash: string): string | undefined =>
    /\$m=\d+,t=\d+,p=\d+\$/.exec(hash)?.[0];

  it('is a well-formed argon2id PHC string', () => {
    expect(DUMMY_ARGON2ID_HASH.startsWith('$argon2id$')).toBe(true);
    expect(phcParams(DUMMY_ARGON2ID_HASH)).toBeDefined();
  });

  it('uses the same argon2 cost parameters as hashPassword', async () => {
    const { hash } = await hashPassword('a-throwaway-value-for-comparison');

    expect(phcParams(DUMMY_ARGON2ID_HASH)).toBe(phcParams(hash));
  });
});
