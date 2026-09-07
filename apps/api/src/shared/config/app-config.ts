import { z } from 'zod';

/**
 * Typed, validated application configuration.
 *
 * The environment is read once, at startup, through this module and nowhere
 * else -- `SPEC.md` §Boundaries requires it, and `eslint.config.mjs` enforces it
 * by banning `process.env` everywhere but here. The point is failure timing: an
 * unvalidated `process.env.DATABASE_URL` is `undefined` at startup and only
 * becomes a problem at the first query, in a request, in production. Parsing it
 * here turns that into a refusal to boot with a message naming the variable.
 */

export const NODE_ENVS = ['development', 'test', 'production'] as const;

export type NodeEnv = (typeof NODE_ENVS)[number];

/**
 * Prisma's PostgreSQL driver adapter accepts a libpq-style connection string.
 * Anything else -- a MySQL URL, a bare hostname, a path -- fails deep inside the
 * driver with a message that does not mention configuration, so it is rejected
 * here where the error can say what is actually wrong.
 */
function isPostgresConnectionString(value: string): boolean {
  try {
    const { protocol } = new URL(value);
    return protocol === 'postgres:' || protocol === 'postgresql:';
  } catch {
    return false;
  }
}

const environmentSchema = z.object({
  DATABASE_URL: z
    .string()
    .min(1, 'must not be empty')
    .refine(
      isPostgresConnectionString,
      'must be a postgres:// or postgresql:// connection string',
    ),
  NODE_ENV: z.enum(NODE_ENVS).default('development'),

  // Access-token signing key: base64-encoded PKCS#8 PEM of an Ed25519 private
  // key (ADR 0003 -- EdDSA). Optional here on purpose: outside production the
  // application generates an ephemeral keypair at startup so a developer needs
  // no key material to boot. Production without this value refuses to start --
  // enforced in TokenService, not here, because "not set" is only fatal in one
  // NODE_ENV. Base64 wraps the PEM so it survives a single-line env var intact.
  JWT_PRIVATE_KEY: z.string().min(1).optional(),

  // `iss` / `aud` claims. Stable, explicit values -- a token minted for one
  // deployment must not verify against another. Dev defaults so local boot
  // needs no configuration; a real deployment sets both.
  JWT_ISSUER: z.string().min(1).default('valuetracker'),
  JWT_AUDIENCE: z.string().min(1).default('valuetracker-api'),
});

export class AppConfig {
  constructor(
    readonly databaseUrl: string,
    readonly nodeEnv: NodeEnv,
    readonly jwtPrivateKey: string | undefined,
    readonly jwtIssuer: string,
    readonly jwtAudience: string,
  ) {}
}

/**
 * Reads configuration from an arbitrary environment record. It takes the source
 * as an argument rather than reaching for `process.env` itself, which is what
 * makes it testable without mutating global state -- and what lets the one real
 * `process.env` read live in a single, obvious place (`config.module.ts`).
 *
 * @throws Error naming every invalid variable, when validation fails.
 */
export function loadAppConfig(
  source: Record<string, string | undefined>,
): AppConfig {
  const result = environmentSchema.safeParse(source);

  if (!result.success) {
    const problems = result.error.issues
      .map((issue) => `  ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');

    throw new Error(`Invalid environment configuration:\n${problems}`);
  }

  return new AppConfig(
    result.data.DATABASE_URL,
    result.data.NODE_ENV,
    result.data.JWT_PRIVATE_KEY,
    result.data.JWT_ISSUER,
    result.data.JWT_AUDIENCE,
  );
}
