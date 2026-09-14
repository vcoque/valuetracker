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

  // Final-review fix: `targetAmountSchema` bounded the scale (decimal places)
  // but not the precision (integer digits), so a value with more integer
  // digits than `NUMERIC(20,4)` holds (16) passed validation and would have
  // reached Postgres as `22003 numeric field overflow` -- an unhandled 500,
  // since portfolio.service.ts's Prisma-error mapping doesn't catch that
  // code. 17 integer digits is one past the column's 16-digit capacity.
  it('rejects a target_amount with more than 16 integer digits (precision overflow) with a 400', () => {
    expect(() =>
      pipe.transform({ ...valid, targetAmount: '12345678901234567' }), // 17 digits
    ).toThrow(BadRequestException);
  });

  it('accepts a target_amount at exactly the 16-integer-digit boundary', () => {
    const result = pipe.transform({ ...valid, targetAmount: '9999999999999999' });
    expect(result.targetAmount).toBe('9999999999999999');
  });

  // Final-review fix, mirroring `instrument.ts`'s `dateOnlySchema` cases
  // (F15.2, fix round 1): `targetDateSchema` only regex-checked the
  // `YYYY-MM-DD` shape, so a well-shaped but non-existent date silently
  // rolled over via `new Date(...)` (`"2035-02-30"` -> `"2035-03-02"`)
  // instead of being rejected. These are the same four cases exercised for
  // `instrument.ts`'s identical defect: invalid day-of-month, invalid
  // month, leap-year Feb 29 accepted, non-leap Feb 29 rejected.
  it('rejects an invalid day-of-month in targetDate ("2035-02-30") with a 400', () => {
    expect(() =>
      pipe.transform({ ...valid, targetDate: '2035-02-30' }),
    ).toThrow(BadRequestException);
  });

  it('rejects an invalid month in targetDate ("2035-13-01") with a 400', () => {
    expect(() =>
      pipe.transform({ ...valid, targetDate: '2035-13-01' }),
    ).toThrow(BadRequestException);
  });

  it('accepts a leap-year Feb 29 in targetDate ("2024-02-29")', () => {
    const result = pipe.transform({ ...valid, targetDate: '2024-02-29' });
    expect(result.targetDate).toBe('2024-02-29');
  });

  it('rejects a non-leap-year Feb 29 in targetDate ("2023-02-29") with a 400', () => {
    expect(() =>
      pipe.transform({ ...valid, targetDate: '2023-02-29' }),
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

  it('rejects a target_amount with more than 16 integer digits (precision overflow)', () => {
    expect(() =>
      pipe.transform({ targetAmount: '12345678901234567' }), // 17 digits
    ).toThrow(BadRequestException);
  });

  it('rejects an invalid calendar date in targetDate ("2035-02-30")', () => {
    expect(() => pipe.transform({ targetDate: '2035-02-30' })).toThrow(
      BadRequestException,
    );
  });
});
