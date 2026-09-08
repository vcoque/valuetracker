-- DropForeignKey
ALTER TABLE "session" DROP CONSTRAINT "session_replaced_by_id_fkey";

-- AddForeignKey
ALTER TABLE "session" ADD CONSTRAINT "session_replaced_by_id_fkey" FOREIGN KEY ("replaced_by_id") REFERENCES "session"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
