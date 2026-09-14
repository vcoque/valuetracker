-- CreateTable
CREATE TABLE "portfolio" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "name" VARCHAR(128) NOT NULL,
    "description" VARCHAR(512),
    "objective" VARCHAR(255),
    "base_currency_code" CHAR(3) NOT NULL,
    "target_amount" DECIMAL(20,4),
    "target_date" DATE,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "archived_at" TIMESTAMP(3),

    CONSTRAINT "portfolio_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "portfolio_user_id_name_key" ON "portfolio"("user_id", "name");

-- AddForeignKey
ALTER TABLE "portfolio" ADD CONSTRAINT "portfolio_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "portfolio" ADD CONSTRAINT "portfolio_base_currency_code_fkey" FOREIGN KEY ("base_currency_code") REFERENCES "currency"("code") ON DELETE RESTRICT ON UPDATE CASCADE;
