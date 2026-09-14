-- ============================================================================
-- HAND-AUTHORED SQL -- docs/adr/0005-instrument-inheritance.md (Ruling S7).
-- Everything above the next "-- CreateTable"/"-- AddForeignKey" marker back
-- to here was emitted by `prisma migrate dev --create-only` from
-- schema.prisma; the sections below are added by hand because Prisma 7 has
-- no schema-language syntax for a lookup-table-only column, a CHECK
-- constraint, a trigger, or a partial index. This file is edited only
-- *before* its first `prisma migrate dev` apply -- see the ADR's "Deviation
-- from SPEC.md".
-- ============================================================================

-- Discriminator as a lookup table, not a CHECK(...IN(...)) list: registering
-- a fifth asset class is then an INSERT here, touching no existing table
-- (SPEC-catalog.md "Adding a new asset class ... No existing table changes").
CREATE TABLE "instrument_type" (
    "code" TEXT NOT NULL,

    CONSTRAINT "instrument_type_pkey" PRIMARY KEY ("code")
);

INSERT INTO "instrument_type" ("code") VALUES ('EQUITY'), ('ETF'), ('FIXED_INCOME'), ('CRYPTO');

-- CreateTable
CREATE TABLE "instrument" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "instrument_type" VARCHAR(24) NOT NULL,
    "owner_user_id" UUID,
    "name" VARCHAR(255) NOT NULL,
    "currency_code" CHAR(3) NOT NULL,
    "data_source_id" UUID,
    "status" VARCHAR(16) NOT NULL,
    "is_variable_income" BOOLEAN NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "instrument_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "instrument_equity" (
    "instrument_id" UUID NOT NULL,
    "instrument_type" VARCHAR(24) NOT NULL DEFAULT 'EQUITY',
    "owner_user_id" UUID,
    "ticker" VARCHAR(16) NOT NULL,
    "exchange_code" VARCHAR(16) NOT NULL,
    "isin" CHAR(12),
    "sector" VARCHAR(64),
    "country_code" CHAR(2),

    CONSTRAINT "instrument_equity_pkey" PRIMARY KEY ("instrument_id")
);

-- CreateTable
CREATE TABLE "instrument_etf" (
    "instrument_id" UUID NOT NULL,
    "instrument_type" VARCHAR(24) NOT NULL DEFAULT 'ETF',
    "owner_user_id" UUID,
    "ticker" VARCHAR(16) NOT NULL,
    "exchange_code" VARCHAR(16) NOT NULL,
    "isin" CHAR(12),
    "benchmark_index" VARCHAR(64),
    "expense_ratio" DECIMAL(6,4),
    "replication_method" VARCHAR(16),

    CONSTRAINT "instrument_etf_pkey" PRIMARY KEY ("instrument_id")
);

-- CreateTable
CREATE TABLE "instrument_fixed_income" (
    "instrument_id" UUID NOT NULL,
    "instrument_type" VARCHAR(24) NOT NULL DEFAULT 'FIXED_INCOME',
    "owner_user_id" UUID,
    "issuer_name" VARCHAR(255) NOT NULL,
    "issuer_tax_id" VARCHAR(32),
    "indexation_type" VARCHAR(16) NOT NULL,
    "contracted_rate" DECIMAL(10,6),
    "index_percentage" DECIMAL(10,4),
    "issue_date" DATE NOT NULL,
    "maturity_date" DATE NOT NULL,
    "coupon_frequency" VARCHAR(16) NOT NULL,
    "day_count_convention" VARCHAR(16) NOT NULL,
    "face_value" DECIMAL(20,6),
    "allows_early_redemption" BOOLEAN NOT NULL,
    "tax_regime" VARCHAR(24),

    CONSTRAINT "instrument_fixed_income_pkey" PRIMARY KEY ("instrument_id")
);

-- CreateTable
CREATE TABLE "instrument_crypto" (
    "instrument_id" UUID NOT NULL,
    "instrument_type" VARCHAR(24) NOT NULL DEFAULT 'CRYPTO',
    "owner_user_id" UUID,
    "symbol" VARCHAR(16) NOT NULL,
    "network" VARCHAR(32),
    "contract_address" VARCHAR(128),
    "decimals" INTEGER NOT NULL,

    CONSTRAINT "instrument_crypto_pkey" PRIMARY KEY ("instrument_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "instrument_id_type_uk" ON "instrument"("id", "instrument_type");

-- AddForeignKey
ALTER TABLE "instrument" ADD CONSTRAINT "instrument_owner_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "instrument" ADD CONSTRAINT "instrument_currency_code_fkey" FOREIGN KEY ("currency_code") REFERENCES "currency"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "instrument" ADD CONSTRAINT "instrument_data_source_id_fkey" FOREIGN KEY ("data_source_id") REFERENCES "data_source"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Hand-authored: FK to the hand-authored instrument_type lookup table above.
-- Not schema.prisma-generated because instrument_type is deliberately not a
-- Prisma model (see the header comment on the `Instrument` model).
ALTER TABLE "instrument" ADD CONSTRAINT "instrument_instrument_type_fkey" FOREIGN KEY ("instrument_type") REFERENCES "instrument_type"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "instrument_equity" ADD CONSTRAINT "instrument_equity_instrument_id_fkey" FOREIGN KEY ("instrument_id") REFERENCES "instrument"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "instrument_equity" ADD CONSTRAINT "instrument_equity_exchange_code_fkey" FOREIGN KEY ("exchange_code") REFERENCES "exchange"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "instrument_etf" ADD CONSTRAINT "instrument_etf_instrument_id_fkey" FOREIGN KEY ("instrument_id") REFERENCES "instrument"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "instrument_etf" ADD CONSTRAINT "instrument_etf_exchange_code_fkey" FOREIGN KEY ("exchange_code") REFERENCES "exchange"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "instrument_fixed_income" ADD CONSTRAINT "instrument_fixed_income_instrument_id_fkey" FOREIGN KEY ("instrument_id") REFERENCES "instrument"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "instrument_crypto" ADD CONSTRAINT "instrument_crypto_instrument_id_fkey" FOREIGN KEY ("instrument_id") REFERENCES "instrument"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ============================================================================
-- HAND-AUTHORED SQL (continued) -- the three invariants Prisma cannot state:
-- "exactly one specialization row, matching instrument_type", the public
-- natural-key uniqueness, and is_variable_income. See
-- docs/adr/0005-instrument-inheritance.md for the full write-up; this is the
-- production version of the DDL the Task 5 spike proved.
-- ============================================================================

-- `is_variable_income` is derived from `instrument_type` and must never be
-- trusted from a client (SPEC-catalog.md AC). Enforced here, not merely
-- validated in application code.
ALTER TABLE "instrument" ADD CONSTRAINT "instrument_is_variable_income_chk"
  CHECK ("is_variable_income" = ("instrument_type" <> 'FIXED_INCOME'));

-- Each specialization pins its own discriminator and re-declares the
-- composite FK against `instrument_id_type_uk`, so a specialization row
-- cannot claim a type its base row does not have. This is what rejects both
-- "wrong specialization type" and "a second specialization of another type"
-- (SQLSTATE 23503 in both cases).
ALTER TABLE "instrument_equity" ADD CONSTRAINT "instrument_equity_type_chk"
  CHECK ("instrument_type" = 'EQUITY');
ALTER TABLE "instrument_equity" ADD CONSTRAINT "instrument_equity_matches_base"
  FOREIGN KEY ("instrument_id", "instrument_type") REFERENCES "instrument" ("id", "instrument_type");

ALTER TABLE "instrument_etf" ADD CONSTRAINT "instrument_etf_type_chk"
  CHECK ("instrument_type" = 'ETF');
ALTER TABLE "instrument_etf" ADD CONSTRAINT "instrument_etf_matches_base"
  FOREIGN KEY ("instrument_id", "instrument_type") REFERENCES "instrument" ("id", "instrument_type");

ALTER TABLE "instrument_fixed_income" ADD CONSTRAINT "instrument_fixed_income_type_chk"
  CHECK ("instrument_type" = 'FIXED_INCOME');
ALTER TABLE "instrument_fixed_income" ADD CONSTRAINT "instrument_fixed_income_matches_base"
  FOREIGN KEY ("instrument_id", "instrument_type") REFERENCES "instrument" ("id", "instrument_type");

ALTER TABLE "instrument_crypto" ADD CONSTRAINT "instrument_crypto_type_chk"
  CHECK ("instrument_type" = 'CRYPTO');
ALTER TABLE "instrument_crypto" ADD CONSTRAINT "instrument_crypto_matches_base"
  FOREIGN KEY ("instrument_id", "instrument_type") REFERENCES "instrument" ("id", "instrument_type");

-- The partial unique indexes' predicate column (`owner_user_id`) lives on
-- `instrument`, but the natural-key columns live on the specialization
-- tables. Denormalise `owner_user_id` onto each specialization and keep it
-- honest with a BEFORE trigger that copies it from the base row every time a
-- specialization row is inserted or its FK/copy is touched -- this is what
-- makes the partial indexes below correct.
CREATE FUNCTION instrument_sync_owner_user_id() RETURNS trigger AS $$
  BEGIN
    SELECT i.owner_user_id INTO NEW.owner_user_id
    FROM "instrument" i WHERE i.id = NEW.instrument_id;
    RETURN NEW;
  END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER instrument_equity_sync_owner
  BEFORE INSERT OR UPDATE OF instrument_id, owner_user_id ON "instrument_equity"
  FOR EACH ROW EXECUTE FUNCTION instrument_sync_owner_user_id();

CREATE TRIGGER instrument_etf_sync_owner
  BEFORE INSERT OR UPDATE OF instrument_id, owner_user_id ON "instrument_etf"
  FOR EACH ROW EXECUTE FUNCTION instrument_sync_owner_user_id();

CREATE TRIGGER instrument_fixed_income_sync_owner
  BEFORE INSERT OR UPDATE OF instrument_id, owner_user_id ON "instrument_fixed_income"
  FOR EACH ROW EXECUTE FUNCTION instrument_sync_owner_user_id();

CREATE TRIGGER instrument_crypto_sync_owner
  BEFORE INSERT OR UPDATE OF instrument_id, owner_user_id ON "instrument_crypto"
  FOR EACH ROW EXECUTE FUNCTION instrument_sync_owner_user_id();

-- Public natural-key uniqueness, public rows only (`owner_user_id IS NULL`).
-- `instrument_etf` gets its own index, not shared with `instrument_equity`'s
-- (SPEC-catalog.md). `instrument_fixed_income` has no natural public key in
-- this spec, so it carries no such index.
CREATE UNIQUE INDEX "instrument_equity_public_natural_key"
  ON "instrument_equity" ("exchange_code", "ticker") WHERE "owner_user_id" IS NULL;

CREATE UNIQUE INDEX "instrument_etf_public_natural_key"
  ON "instrument_etf" ("exchange_code", "ticker") WHERE "owner_user_id" IS NULL;

CREATE UNIQUE INDEX "instrument_crypto_public_natural_key"
  ON "instrument_crypto" ("symbol", "network") WHERE "owner_user_id" IS NULL;

-- "Exactly one specialization row" -- the half the composite FKs above do
-- NOT cover (they allow zero). The function counts rows across the four
-- specialization tables for NEW.id; DEFERRED so the mid-transaction state
-- (base row inserted, specialization not yet) is legal, since a correct
-- caller always writes base + specialization inside one transaction (Task
-- 15's create path, and every constraint proof in
-- instrument-schema.int-spec.ts).
CREATE FUNCTION instrument_require_one_specialization() RETURNS trigger AS $$
  DECLARE
    spec_count int;
  BEGIN
    SELECT
        (SELECT count(*) FROM "instrument_equity"       WHERE instrument_id = NEW.id)
      + (SELECT count(*) FROM "instrument_etf"           WHERE instrument_id = NEW.id)
      + (SELECT count(*) FROM "instrument_fixed_income"  WHERE instrument_id = NEW.id)
      + (SELECT count(*) FROM "instrument_crypto"        WHERE instrument_id = NEW.id)
      INTO spec_count;

    IF spec_count <> 1 THEN
      RAISE EXCEPTION
        'instrument % has % specialization rows; exactly one is required', NEW.id, spec_count
        USING ERRCODE = 'check_violation';
    END IF;

    RETURN NULL;
  END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER instrument_one_specialization
  AFTER INSERT ON "instrument"
  INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION instrument_require_one_specialization();
