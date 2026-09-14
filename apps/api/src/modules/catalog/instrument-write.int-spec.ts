import { randomUUID } from 'node:crypto';

import { Test, type TestingModule } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';

import { seedReferenceData } from '../../../prisma/seed';
import { PrismaModule } from '../../shared/prisma/prisma.module';
import { PrismaService } from '../../shared/prisma/prisma.service';
import type { CreateFixedIncomeInstrumentRequest } from './dto/instrument.dto';
import { InstrumentService } from './instrument.service';

/**
 * Task 15's write path: `POST`/`PATCH /instruments` (FIXED_INCOME only,
 * `SPEC-catalog.md` §API Surface). Two things get proven here that
 * `instrument.e2e-spec.ts` (HTTP-level) does not reach:
 *
 *  1. Atomicity, at the database, of the exact nested-`create` call
 *     `InstrumentService.create` issues -- a forced failure of the SECOND
 *     insert (`instrument_fixed_income`) leaves zero rows of EITHER kind,
 *     the same "insert base, force the specialization insert to fail, count
 *     both back to zero" technique `instrument-schema.int-spec.ts` Case 1
 *     uses, adapted to go through the real nested-create call rather than
 *     two raw `INSERT`s.
 *  2. `InstrumentService.create`/`update` themselves, instantiated directly
 *     against a real Postgres (the constructor takes only `PrismaService`,
 *     no other DI needed) -- ownership scoping and the merged-date
 *     `maturityDate`-after-`issueDate` re-check that only the service can
 *     do (the wire schema alone cannot see a field a PATCH left out).
 */
describe('instrument write path (integration)', () => {
  let moduleRef: TestingModule;
  let prisma: PrismaService;
  let service: InstrumentService;

  const currencyCode = 'BRL';

  beforeEach(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [PrismaModule],
    }).compile();
    await moduleRef.init();
    prisma = moduleRef.get(PrismaService);
    service = new InstrumentService(prisma);

    await seedReferenceData(prisma);
  });

  afterEach(async () => {
    await moduleRef.close();
  });

  async function createUser(email: string): Promise<{ id: string }> {
    return prisma.user.create({
      data: {
        email,
        displayName: 'Test User',
        baseCurrencyCode: currencyCode,
        timezone: 'America/Sao_Paulo',
      },
      select: { id: true },
    });
  }

  function validRequest(
    overrides: Partial<CreateFixedIncomeInstrumentRequest> = {},
  ): CreateFixedIncomeInstrumentRequest {
    return {
      name: 'Tesouro IPCA+ 2030',
      currencyCode,
      issuerName: 'Tesouro Nacional',
      issuerTaxId: null,
      indexationType: 'IPCA',
      contractedRate: '5.500000',
      indexPercentage: null,
      issueDate: '2024-01-01',
      maturityDate: '2030-01-01',
      couponFrequency: 'SEMIANNUAL',
      dayCountConvention: 'BUS252',
      faceValue: '1000.000000',
      allowsEarlyRedemption: false,
      taxRegime: 'EXEMPT',
      ...overrides,
    };
  }

  // --- Atomicity: forced failure of the SECOND insert -----------------------

  it(
    'a forced failure of the instrument_fixed_income insert leaves zero rows in ' +
      'either table (nested create, mid-transaction rollback)',
    async () => {
      const name = `Force-fail CDB ${randomUUID()}`;

      // The exact nested-create shape `InstrumentService.create` uses, except
      // the specialization's own `instrument_type` is forced to a value that
      // does not match its base row's ('FIXED_INCOME') -- violating
      // `instrument_fixed_income_type_chk` (and/or the composite
      // `instrument_fixed_income_matches_base` FK) on the SECOND insert,
      // after the base `instrument` row has already been written within the
      // same implicit transaction.
      const attempt = prisma.instrument.create({
        data: {
          instrumentType: 'FIXED_INCOME',
          name,
          currencyCode,
          status: 'ACTIVE',
          isVariableIncome: false,
          fixedIncome: {
            create: {
              instrumentType: 'EQUITY',
              issuerName: 'Should Not Persist',
              indexationType: 'CDI',
              issueDate: new Date('2024-01-01'),
              maturityDate: new Date('2030-01-01'),
              couponFrequency: 'NONE',
              dayCountConvention: 'BUS252',
              allowsEarlyRedemption: false,
            },
          },
        },
      });

      await expect(attempt).rejects.toThrow();

      // Zero rows of EITHER kind -- not just that instrument_fixed_income is
      // empty (that would also be true if the base insert had simply never
      // run), but that the base row the first statement wrote is gone too.
      const instrumentCount = await prisma.instrument.count({ where: { name } });
      expect(instrumentCount).toBe(0);
      const fixedIncomeCount = await prisma.instrumentFixedIncome.count({
        where: { issuerName: 'Should Not Persist' },
      });
      expect(fixedIncomeCount).toBe(0);
    },
  );

  // --- InstrumentService.create ----------------------------------------------

  describe('InstrumentService.create', () => {
    it('writes base + fixed-income specialization atomically and reads back the discriminated union', async () => {
      const owner = await createUser('creator@example.com');

      const created = await service.create(owner.id, validRequest());

      expect(created).toMatchObject({
        instrumentType: 'FIXED_INCOME',
        ownerUserId: owner.id,
        status: 'ACTIVE',
        isVariableIncome: false,
        issuerName: 'Tesouro Nacional',
        indexationType: 'IPCA',
        contractedRate: '5.500000',
        faceValue: '1000.000000',
        issueDate: '2024-01-01',
        maturityDate: '2030-01-01',
      });

      // Both rows are really there, independently of the service's own
      // read-back.
      const row = await prisma.instrument.findUniqueOrThrow({
        where: { id: created.id },
        include: { fixedIncome: true },
      });
      expect(row.ownerUserId).toBe(owner.id);
      expect(row.instrumentType).toBe('FIXED_INCOME');
      expect(row.fixedIncome).not.toBeNull();
      expect(row.fixedIncome?.issuerName).toBe('Tesouro Nacional');
    });

    it('never creates a public instrument: ownerUserId is always the caller, never null', async () => {
      const owner = await createUser('never-public@example.com');

      const created = await service.create(owner.id, validRequest());

      expect(created.ownerUserId).toBe(owner.id);
      expect(created.ownerUserId).not.toBeNull();
    });

    it('rejects a currencyCode with no matching currency row (P2003 -> 400)', async () => {
      const owner = await createUser('bad-currency@example.com');

      await expect(
        service.create(owner.id, validRequest({ currencyCode: 'ZZZ' })),
      ).rejects.toMatchObject({ status: 400 });
    });
  });

  // --- InstrumentService.update -----------------------------------------------

  describe('InstrumentService.update', () => {
    it("only touches instruments the caller owns -- another user's is a 404", async () => {
      const owner = await createUser('owner-b@example.com');
      const stranger = await createUser('stranger-b@example.com');
      const created = await service.create(owner.id, validRequest());

      await expect(
        service.update(stranger.id, created.id, { issuerName: 'Hijacked' }),
      ).rejects.toBeInstanceOf(NotFoundException);

      // Unchanged.
      const stillOwned = await prisma.instrumentFixedIncome.findUniqueOrThrow({
        where: { instrumentId: created.id },
      });
      expect(stillOwned.issuerName).toBe('Tesouro Nacional');
    });

    it('a PUBLIC instrument (ownerUserId null) is 404 to PATCH, even for its creator-in-fact', async () => {
      const someone = await createUser('someone-public@example.com');
      const publicInstrument = await prisma.instrument.create({
        data: {
          instrumentType: 'FIXED_INCOME',
          name: 'Public Treasury Bond',
          currencyCode,
          status: 'ACTIVE',
          isVariableIncome: false,
          fixedIncome: {
            create: {
              issuerName: 'Tesouro Nacional',
              indexationType: 'SELIC',
              issueDate: new Date('2024-01-01'),
              maturityDate: new Date('2029-01-01'),
              couponFrequency: 'NONE',
              dayCountConvention: 'BUS252',
              allowsEarlyRedemption: false,
            },
          },
        },
      });

      await expect(
        service.update(someone.id, publicInstrument.id, { issuerName: 'Hijacked' }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('applies a partial patch, leaving unspecified fields (and forbidden ones) untouched', async () => {
      const owner = await createUser('patcher@example.com');
      const created = await service.create(owner.id, validRequest());

      const updated = await service.update(owner.id, created.id, {
        issuerName: 'Banco Renamed',
        contractedRate: '6.000000',
      });

      expect(updated).toMatchObject({
        issuerName: 'Banco Renamed',
        contractedRate: '6.000000',
        // Untouched.
        indexationType: 'IPCA',
        faceValue: '1000.000000',
        issueDate: '2024-01-01',
        maturityDate: '2030-01-01',
        ownerUserId: owner.id,
        instrumentType: 'FIXED_INCOME',
        isVariableIncome: false,
      });
    });

    it(
      're-validates maturityDate-after-issueDate against the MERGED (current + patch) pair, ' +
        'not just what the patch itself supplies',
      async () => {
        const owner = await createUser('merge-dates@example.com');
        // issueDate 2024-01-01, maturityDate 2030-01-01.
        const created = await service.create(owner.id, validRequest());

        // Patch supplies only maturityDate, moving it to BEFORE the current
        // (unpatched) issueDate. The wire schema's own .refine() cannot catch
        // this -- it only sees the patch, which has no issueDate in it at
        // all -- so this is specifically proving the service's merge-then-
        // validate step.
        await expect(
          service.update(owner.id, created.id, { maturityDate: '2020-01-01' }),
        ).rejects.toMatchObject({ status: 400 });

        // Unchanged.
        const stillOriginal = await prisma.instrumentFixedIncome.findUniqueOrThrow({
          where: { instrumentId: created.id },
        });
        expect(stillOriginal.maturityDate.toISOString().slice(0, 10)).toBe('2030-01-01');
      },
    );

    it('rejects an update for a non-existent id with 404', async () => {
      const owner = await createUser('missing-patch@example.com');

      await expect(
        service.update(owner.id, randomUUID(), { issuerName: 'Ghost' }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
