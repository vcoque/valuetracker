import {
  createParamDecorator,
  type ExecutionContext,
  InternalServerErrorException,
} from '@nestjs/common';

import type { AuthenticatedRequest } from './auth.guard';

/** Which identifier `@CurrentUser(...)` returns. Defaults to the user id. */
export type CurrentUserField = 'userId' | 'sessionId';

/**
 * Injects the authenticated caller's id into a handler parameter:
 *
 *   findMine(@CurrentUser() userId: string) { ... }
 *   logout(@CurrentUser('sessionId') sessionId: string) { ... }
 *
 * `AuthGuard` must run first (it is what populates the request). Reaching a
 * handler with neither field set means the route is missing `@UseGuards(
 * AuthGuard)` -- a wiring bug, so this throws rather than handing a controller
 * `undefined` where it expects a real id.
 *
 * This is the stable contract Phases 2-3 build on; keep it small.
 */
export const CurrentUser = createParamDecorator(
  (field: CurrentUserField | undefined, context: ExecutionContext): string => {
    const request = context
      .switchToHttp()
      .getRequest<AuthenticatedRequest>();

    const value =
      field === 'sessionId' ? request.sessionId : request.userId;

    if (typeof value !== 'string') {
      throw new InternalServerErrorException(
        'CurrentUser used on a route without AuthGuard',
      );
    }
    return value;
  },
);
