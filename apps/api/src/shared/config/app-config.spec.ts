import { AppConfig, loadAppConfig } from './app-config';

const VALID_URL = 'postgresql://user:pw@localhost:5432/valuetracker';

describe('loadAppConfig', () => {
  it('returns a typed config for a valid environment', () => {
    const config = loadAppConfig({
      DATABASE_URL: VALID_URL,
      NODE_ENV: 'production',
    });

    expect(config).toBeInstanceOf(AppConfig);
    expect(config.databaseUrl).toBe(VALID_URL);
    expect(config.nodeEnv).toBe('production');
  });

  it('defaults NODE_ENV to development when it is absent', () => {
    expect(loadAppConfig({ DATABASE_URL: VALID_URL }).nodeEnv).toBe(
      'development',
    );
  });

  it('accepts the postgres:// scheme as well as postgresql://', () => {
    const url = 'postgres://user:pw@db:5432/valuetracker';

    expect(loadAppConfig({ DATABASE_URL: url }).databaseUrl).toBe(url);
  });

  it('names the missing variable rather than failing later at query time', () => {
    expect(() => loadAppConfig({})).toThrow(/DATABASE_URL/);
  });

  it('rejects a connection string for the wrong engine', () => {
    // The failure this prevents is a slow one: a MySQL URL reaches the driver,
    // which fails with a protocol error naming neither the variable nor the
    // file it came from.
    expect(() =>
      loadAppConfig({ DATABASE_URL: 'mysql://user:pw@localhost:3306/vt' }),
    ).toThrow(/postgres/);
  });

  it('rejects a value that is not a URL at all', () => {
    expect(() => loadAppConfig({ DATABASE_URL: 'localhost:5432' })).toThrow(
      /DATABASE_URL/,
    );
  });

  it('rejects an empty string, which process.env produces for an unset-but-declared var', () => {
    expect(() => loadAppConfig({ DATABASE_URL: '' })).toThrow(/DATABASE_URL/);
  });

  it('rejects an unknown NODE_ENV instead of silently accepting it', () => {
    expect(() =>
      loadAppConfig({ DATABASE_URL: VALID_URL, NODE_ENV: 'staging' }),
    ).toThrow(/NODE_ENV/);
  });

  it('reports a whole-value failure against (root) rather than against no field', () => {
    // Not reachable from `process.env`, which is always an object -- but the
    // function is exported and takes any record, and an issue carrying an empty
    // path would otherwise render as a blank field name in the error message.
    const notAnEnvironment = null as unknown as Record<
      string,
      string | undefined
    >;

    expect(() => loadAppConfig(notAnEnvironment)).toThrow(/\(root\)/);
  });
});
