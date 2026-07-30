-- AlterTable
ALTER TABLE "Run" ADD COLUMN     "alternativeSuggestions" JSONB,
ADD COLUMN     "alternativeSuggestionsGeneratedAt" TIMESTAMP(3),
ADD COLUMN     "alternativeSuggestionsModel" TEXT,
ADD COLUMN     "variantTargetLocator" JSONB;
