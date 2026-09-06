-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "currency" (
    "code" CHAR(3) NOT NULL,
    "name" VARCHAR(64) NOT NULL,
    "symbol" VARCHAR(8),
    "minor_unit" INTEGER NOT NULL,

    CONSTRAINT "currency_pkey" PRIMARY KEY ("code")
);

