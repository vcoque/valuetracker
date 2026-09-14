import { toInstrumentStatus } from './instrument.service';

/**
 * F14.1 (fix round 1): `status` has no database-level constraint (the Task
 * 13 migration declares it `VARCHAR(16) NOT NULL` only -- no CHECK, no FK),
 * unlike `instrumentType` which the composite/lookup-table FK does enforce.
 * `toInstrumentRow` must therefore validate `status`, not blindly cast it --
 * this pins that behaviour directly against the exported helper, without
 * needing a `PrismaService` or a real row.
 */
describe('toInstrumentStatus', () => {
  it.each(['ACTIVE', 'DELISTED', 'MATURED', 'SUSPENDED'])(
    'accepts the known status %s',
    (status) => {
      expect(toInstrumentStatus('instrument-id', status)).toBe(status);
    },
  );

  it('throws a descriptive error for an unrecognized status rather than casting it through', () => {
    expect(() => toInstrumentStatus('instrument-id', 'BOGUS')).toThrow(
      'Instrument instrument-id has an unrecognized status: "BOGUS"',
    );
  });

  it('throws for an empty string', () => {
    expect(() => toInstrumentStatus('instrument-id', '')).toThrow(
      'Instrument instrument-id has an unrecognized status: ""',
    );
  });
});
