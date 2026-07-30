-- AlterTable
ALTER TABLE "Run" ADD COLUMN     "sourceRunId" TEXT;

-- AddForeignKey
ALTER TABLE "Run" ADD CONSTRAINT "Run_sourceRunId_fkey" FOREIGN KEY ("sourceRunId") REFERENCES "Run"("id") ON DELETE SET NULL ON UPDATE CASCADE;
