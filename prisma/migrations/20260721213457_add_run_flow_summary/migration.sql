-- AlterTable
ALTER TABLE "Run" ADD COLUMN     "summary" JSONB,
ADD COLUMN     "summaryGeneratedAt" TIMESTAMP(3),
ADD COLUMN     "summaryModel" TEXT;
