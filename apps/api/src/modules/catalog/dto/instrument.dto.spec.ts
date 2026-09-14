import { BadRequestException } from '@nestjs/common';

import { ZodValidationPipe } from '../../../shared/http/zod-validation.pipe';
import {
  createFixedIncomeInstrumentRequestSchema,
  etfInstrumentResponseSchema,
  updateFixedIncomeInstrumentRequestSchema,
} from './instrument.dto';

/**
 * Final-review fix: `decimalStringSchema` (`@valuetracker/contract`'s
 * `instrument.ts`) used to bound only the shape of a decimal string, not the
 * number of integer digits, so a value with more integer digits than its
 * backing `NUMERIC(precision, scale)` column holds passed validation and
 * would have reached Postgres as `22003 numeric field overflow` -- an
 * unhandled 500, since none of the three services' Prisma-error mapping
 * catches that code. It is now parameterized per field
 * (`contractedRate` decimal(10,6) -> 4 integer digits, `indexPercentage`
 * decimal(10,4) -> 6 integer digits, `faceValue` decimal(20,6) -> 14
 * integer digits, `expenseRatio` decimal(6,4) -> 2 integer digits -- see
 * `apps/api/prisma/schema.prisma`'s `InstrumentFixedIncome`/`InstrumentEtf`
 * models). These tests pin the boundary for each field: one digit past the
 * column's capacity is rejected, exactly at capacity is accepted.
 */
function validCdb(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'Banco X CDB 2028',
    currencyCode: 'BRL',
    issuerName: 'Banco X',
    indexationType: 'CDI',
    contractedRate: '5.000000',
    indexPercentage: '110.0000',
    issueDate: '2024-01-01',
    maturityDate: '2028-01-01',
    couponFrequency: 'NONE',
    dayCountConvention: 'BUS252',
    faceValue: '1000.000000',
    allowsEarlyRedemption: true,
    taxRegime: 'REGRESSIVE_IR',
    ...overrides,
  };
}

describe('createFixedIncomeInstrumentRequestSchema (decimal precision bounds)', () => {
  const pipe = new ZodValidationPipe(createFixedIncomeInstrumentRequestSchema);

  it('rejects a contractedRate with more than 4 integer digits (NUMERIC(10,6)) with a 400', () => {
    expect(() =>
      pipe.transform(validCdb({ contractedRate: '12345.000000' })), // 5 int digits
    ).toThrow(BadRequestException);
  });

  it('accepts a contractedRate at exactly the 4-integer-digit boundary', () => {
    const result = pipe.transform(validCdb({ contractedRate: '9999.000000' }));
    expect(result.contractedRate).toBe('9999.000000');
  });

  it('rejects an indexPercentage with more than 6 integer digits (NUMERIC(10,4)) with a 400', () => {
    expect(() =>
      pipe.transform(validCdb({ indexPercentage: '1234567.0000' })), // 7 int digits
    ).toThrow(BadRequestException);
  });

  it('accepts an indexPercentage at exactly the 6-integer-digit boundary', () => {
    const result = pipe.transform(validCdb({ indexPercentage: '999999.0000' }));
    expect(result.indexPercentage).toBe('999999.0000');
  });

  it('rejects a faceValue with more than 14 integer digits (NUMERIC(20,6)) with a 400', () => {
    expect(() =>
      pipe.transform(validCdb({ faceValue: '123456789012345.000000' })), // 15 int digits
    ).toThrow(BadRequestException);
  });

  it('accepts a faceValue at exactly the 14-integer-digit boundary', () => {
    const result = pipe.transform(validCdb({ faceValue: '99999999999999.000000' }));
    expect(result.faceValue).toBe('99999999999999.000000');
  });
});

describe('updateFixedIncomeInstrumentRequestSchema (decimal precision bounds)', () => {
  const pipe = new ZodValidationPipe(updateFixedIncomeInstrumentRequestSchema);

  it('rejects a PATCH faceValue with more than 14 integer digits with a 400', () => {
    expect(() =>
      pipe.transform({ faceValue: '123456789012345.000000' }), // 15 int digits
    ).toThrow(BadRequestException);
  });
});

/**
 * `expenseRatio` (`instrument_etf.expense_ratio decimal(6,4)`, 2 integer
 * digits) is response-only today -- no request schema accepts it, since ETF
 * creation is out of this branch's scope (`SPEC-catalog.md` §API Surface:
 * fixed income only). Bounding it is still correct precedent for whenever
 * ETF writes are added; parsed directly against the response schema since
 * there is no HTTP pipe in front of it yet.
 */
describe('etfInstrumentResponseSchema (decimal precision bounds)', () => {
  const base = {
    id: '00000000-0000-0000-0000-000000000000',
    ownerUserId: null,
    name: 'iShares Test ETF',
    currencyCode: 'BRL',
    dataSourceId: null,
    status: 'ACTIVE' as const,
    isVariableIncome: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    instrumentType: 'ETF' as const,
    ticker: 'TEST11',
    exchangeCode: 'B3',
    isin: null,
    benchmarkIndex: null,
    replicationMethod: null,
  };

  it('rejects an expenseRatio with more than 2 integer digits (NUMERIC(6,4))', () => {
    const result = etfInstrumentResponseSchema.safeParse({ ...base, expenseRatio: '100.0000' });
    expect(result.success).toBe(false);
  });

  it('accepts an expenseRatio at exactly the 2-integer-digit boundary', () => {
    const result = etfInstrumentResponseSchema.safeParse({ ...base, expenseRatio: '99.0000' });
    expect(result.success).toBe(true);
  });
});
