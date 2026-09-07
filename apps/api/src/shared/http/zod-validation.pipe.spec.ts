import { BadRequestException } from '@nestjs/common';
import { z } from 'zod';

import { registerRequestSchema } from '@valuetracker/contract';

import { ZodValidationPipe } from './zod-validation.pipe';

/**
 * The pipe wired onto the `/auth` routes. It must reject bad input with a 400,
 * apply the schema's defaults/normalisation on the way through, and never put a
 * submitted value (a password above all) in the error body.
 */
describe('ZodValidationPipe', () => {
  const pipe = new ZodValidationPipe(registerRequestSchema);

  const valid = {
    email: 'Person@Example.com ',
    password: 'a-sufficiently-long-password',
    displayName: 'Person',
  };

  it('returns the parsed value with defaults and normalisation applied', () => {
    const result = pipe.transform({ ...valid });

    expect(result.email).toBe('person@example.com');
    expect(result.baseCurrencyCode).toBe('BRL');
    expect(result.timezone).toBe('UTC');
    expect(result.clientType).toBe('WEB');
  });

  it('rejects a password shorter than 12 characters with a 400', () => {
    expect(() => pipe.transform({ ...valid, password: 'short' })).toThrow(
      BadRequestException,
    );
  });

  it('rejects a malformed email with a 400', () => {
    expect(() => pipe.transform({ ...valid, email: 'not-an-email' })).toThrow(
      BadRequestException,
    );
  });

  it('names the failing field but never echoes the submitted value', () => {
    const secret = 'short';
    try {
      pipe.transform({ ...valid, password: secret });
      throw new Error('expected a BadRequestException');
    } catch (error) {
      expect(error).toBeInstanceOf(BadRequestException);
      const body = (error as BadRequestException).getResponse();
      const serialised = JSON.stringify(body);
      expect(serialised).toContain('password');
      expect(serialised).not.toContain(secret);
    }
  });

  it('works with any zod schema, not just the auth ones', () => {
    const numberPipe = new ZodValidationPipe(z.object({ n: z.number() }));

    expect(numberPipe.transform({ n: 42 })).toEqual({ n: 42 });
    expect(() => numberPipe.transform({ n: 'x' })).toThrow(BadRequestException);
  });
});
