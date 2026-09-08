import { UnauthorizedException, type ExecutionContext } from '@nestjs/common';

import { AuthGuard, type AuthenticatedRequest } from './auth.guard';
import type { AccessTokenVerifier } from './token.service';

/**
 * `AuthGuard` is deliberately thin: pull the Bearer token, hand it to the
 * injected {@link AccessTokenVerifier}, copy `sub`/`sid` onto the request. The
 * verifier is faked here -- its own rejection matrix (`alg:none`, wrong key,
 * expiry, ...) lives in `token.service.spec.ts` and the e2e.
 */
describe('AuthGuard', () => {
  const contextWith = (
    headers: Record<string, string | string[] | undefined>,
  ): { ctx: ExecutionContext; request: AuthenticatedRequest } => {
    const request: AuthenticatedRequest = { headers };
    const ctx = {
      switchToHttp: () => ({ getRequest: () => request }),
    } as unknown as ExecutionContext;
    return { ctx, request };
  };

  const guardWith = (verifier: Partial<AccessTokenVerifier>): AuthGuard =>
    new AuthGuard(verifier as AccessTokenVerifier);

  it('verifies the Bearer token and attaches userId / sessionId', async () => {
    const verify = jest
      .fn()
      .mockResolvedValue({ sub: 'user-1', sid: 'session-1' });
    const { ctx, request } = contextWith({
      authorization: 'Bearer the.access.token',
    });

    await expect(
      guardWith({ verifyAccessToken: verify }).canActivate(ctx),
    ).resolves.toBe(true);

    expect(verify).toHaveBeenCalledWith('the.access.token');
    expect(request.userId).toBe('user-1');
    expect(request.sessionId).toBe('session-1');
  });

  it('accepts a case-insensitive scheme and trims surrounding space', async () => {
    const verify = jest.fn().mockResolvedValue({ sub: 'u', sid: 's' });
    const { ctx } = contextWith({ authorization: '  bearer   tok  ' });

    await guardWith({ verifyAccessToken: verify }).canActivate(ctx);

    expect(verify).toHaveBeenCalledWith('tok');
  });

  it('401s with no Authorization header, without calling the verifier', async () => {
    const verify = jest.fn();
    const { ctx } = contextWith({});

    await expect(
      guardWith({ verifyAccessToken: verify }).canActivate(ctx),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(verify).not.toHaveBeenCalled();
  });

  it('401s when the header is present but not a Bearer scheme', async () => {
    const verify = jest.fn();
    const { ctx } = contextWith({ authorization: 'Basic dXNlcjpwYXNz' });

    await expect(
      guardWith({ verifyAccessToken: verify }).canActivate(ctx),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(verify).not.toHaveBeenCalled();
  });

  it('propagates the verifier rejection unchanged', async () => {
    const boom = new UnauthorizedException({ message: 'Invalid access token' });
    const { ctx } = contextWith({ authorization: 'Bearer forged' });

    await expect(
      guardWith({
        verifyAccessToken: jest.fn().mockRejectedValue(boom),
      }).canActivate(ctx),
    ).rejects.toBe(boom);
  });
});
