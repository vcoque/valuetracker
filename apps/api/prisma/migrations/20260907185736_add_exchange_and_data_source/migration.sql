-- CreateTable
CREATE TABLE "exchange" (
    "code" VARCHAR(16) NOT NULL,
    "name" VARCHAR(128) NOT NULL,
    "country_code" CHAR(2) NOT NULL,
    "currency_code" CHAR(3) NOT NULL,
    "timezone" VARCHAR(64) NOT NULL,

    CONSTRAINT "exchange_pkey" PRIMARY KEY ("code")
);

-- CreateTable
CREATE TABLE "data_source" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" VARCHAR(64) NOT NULL,
    "description" VARCHAR(255),
    "priority" INTEGER NOT NULL,
    "is_active" BOOLEAN NOT NULL,

    CONSTRAINT "data_source_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "data_source_name_key" ON "data_source"("name");

-- AddForeignKey
ALTER TABLE "exchange" ADD CONSTRAINT "exchange_currency_code_fkey" FOREIGN KEY ("currency_code") REFERENCES "currency"("code") ON DELETE RESTRICT ON UPDATE CASCADE;
