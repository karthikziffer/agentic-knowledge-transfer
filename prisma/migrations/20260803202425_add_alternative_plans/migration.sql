-- AlterTable
ALTER TABLE "Run" ADD COLUMN     "alternativePlans" JSONB,
ADD COLUMN     "alternativePlansGeneratedAt" TIMESTAMP(3),
ADD COLUMN     "alternativePlansModel" TEXT,
ADD COLUMN     "variantPlanSteps" JSONB;
