import { hashPassword, verifyPassword, PASSWORD_ALGORITHM } from './password';

/**
 * Password hashing (SPEC-identity.md AC: "Passwords are hashed with argon2id").
 * Pure domain code -- no database, no framework. The hash carries its own
 * parameters and the algorithm is recorded alongside it so a stored hash can be
 * upgraded in place later.
 */
describe('hashPassword / verifyPassword', () => {
  const plain = 'correct horse battery staple';

  it('round-trips: a freshly hashed password verifies', async () => {
    const { hash } = await hashPassword(plain);

    await expect(verifyPassword(plain, hash)).resolves.toBe(true);
  });

  it('rejects the wrong password', async () => {
    const { hash } = await hashPassword(plain);

    await expect(verifyPassword('wrong password', hash)).resolves.toBe(false);
  });

  it('never returns the plaintext as the hash', async () => {
    const { hash } = await hashPassword(plain);

    expect(hash).not.toContain(plain);
    expect(hash).not.toBe(plain);
  });

  it('produces an argon2id PHC-format hash', async () => {
    const { hash } = await hashPassword(plain);

    expect(hash.startsWith('$argon2id$')).toBe(true);
  });

  it('records the algorithm that produced the hash', async () => {
    const { algorithm } = await hashPassword(plain);

    expect(algorithm).toBe(PASSWORD_ALGORITHM);
    expect(algorithm).toBe('argon2id');
  });

  it('salts: two hashes of the same password differ but both verify', async () => {
    const first = await hashPassword(plain);
    const second = await hashPassword(plain);

    expect(first.hash).not.toBe(second.hash);
    await expect(verifyPassword(plain, first.hash)).resolves.toBe(true);
    await expect(verifyPassword(plain, second.hash)).resolves.toBe(true);
  });

  it('returns false rather than throwing on a malformed hash', async () => {
    await expect(verifyPassword(plain, 'not-a-hash')).resolves.toBe(false);
  });
});
