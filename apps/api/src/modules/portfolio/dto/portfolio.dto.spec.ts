import { BadRequestException } from '@nestjs/common';

import { ZodValidationPipe } from '../../../shared/http/zod-validation.pipe';
import { createPortfolioRequestSchema, updatePortfolioRequestSchema } from './portfolio.dto';

/**
 * The pipe wired onto `POST /portfolios`. `SPEC-portfolio.md` AC:
 * "target_amount rejects a negative value ... stored as NUMERIC, never as a
 * float" -- enforced here, at the HTTP boundary, before a `Decimal` is ever
 * constructed.
 */
describe('createPortfolioRequestSchema', () => {
  const pipe = new ZodValidationPipe(createPortfolioRequestSchema);

  const valid = {
    name: 'Retirement',
    baseCurrencyCode: 'BRL',
  };

  it('accepts the minimal required shape', () => {
    const result = pipe.transform({ ...valid });

    expect(result).toEqual({
      name: 'Retirement',
      baseCurrencyCode: 'BRL',
    });
  });

  it('accepts the full attribute set', () => {
    const result = pipe.transform({
      ...valid,
      description: 'Faculdade da Ana',
      objective: 'buy a house in 10 years',
      targetAmount: '150000.5',
      targetDate: '2035-06-30',
    });

    expect(result).toMatchObject({
      description: 'Faculdade da Ana',
      objective: 'buy a house in 10 years',
      targetAmount: '150000.5',
      targetDate: '2035-06-30',
    });
  });

  it('rejects a negative target_amount with a 400', () => {
    expect(() =>
      pipe.transform({ ...valid, targetAmount: '-1' }),
    ).toThrow(BadRequestException);
  });

  it('accepts arbitrary free text for objective -- never validated against a fixed list (Ruling S2)', () => {
    const result = pipe.transform({
      ...valid,
      objective: 'a completely unstructured goal, not RETIREMENT or GENERAL',
    });

    expect(result.objective).toBe(
      'a completely unstructured goal, not RETIREMENT or GENERAL',
    );
  });

  it('rejects a missing name with a 400', () => {
    expect(() =>
      pipe.transform({ baseCurrencyCode: 'BRL' }),
    ).toThrow(BadRequestException);
  });

  it('rejects a missing base_currency_code with a 400', () => {
    expect(() => pipe.transform({ name: 'Retirement' })).toThrow(
      BadRequestException,
    );
  });

  it('rejects a target_amount with more than 4 decimal places', () => {
    expect(() =>
      pipe.transform({ ...valid, targetAmount: '1.23456' }),
    ).toThrow(BadRequestException);
  });
});

/**
 * The pipe wired onto `PATCH /portfolios/:id`. `SPEC-portfolio.md` AC:
 * "PATCH rejects any attempt to change base_currency_code or user_id, with a
 * clear error naming the reason" -- here, `.strict()` on a schema that never
 * declares those two fields turns either into a 400 naming the offending key,
 * before the request reaches the service (`updatePortfolioRequestSchema`
 * doc comment in `@valuetracker/contract`).
 */
describe('updatePortfolioRequestSchema', () => {
  const pipe = new ZodValidationPipe(updatePortfolioRequestSchema);

  it('accepts a partial patch of the mutable fields', () => {
    const result = pipe.transform({ name: 'New Name' });

    expect(result).toEqual({ name: 'New Name' });
  });

  it('accepts null to clear a nullable field', () => {
    const result = pipe.transform({ description: null });

    expect(result).toEqual({ description: null });
  });

  it('rejects an attempt to change base_currency_code (400, unrecognized key)', () => {
    expect(() =>
      pipe.transform({ name: 'New Name', baseCurrencyCode: 'USD' }),
    ).toThrow(BadRequestException);
  });

  it('rejects an attempt to change user_id (400, unrecognized key)', () => {
    expect(() =>
      pipe.transform({ name: 'New Name', userId: 'some-other-user' }),
    ).toThrow(BadRequestException);
  });

  it('rejects an empty patch -- at least one field is required', () => {
    expect(() => pipe.transform({})).toThrow(BadRequestException);
  });

  it('rejects a negative target_amount', () => {
    expect(() => pipe.transform({ targetAmount: '-1' })).toThrow(
      BadRequestException,
    );
  });
});
