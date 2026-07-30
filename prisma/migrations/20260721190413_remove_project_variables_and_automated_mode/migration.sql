/*
  Warnings:

  - You are about to drop the column `mode` on the `Skill` table. All the data in the column will be lost.
  - You are about to drop the `LlmSettings` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `ProjectVariable` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropForeignKey
ALTER TABLE "LlmSettings" DROP CONSTRAINT "LlmSettings_userId_fkey";

-- DropForeignKey
ALTER TABLE "ProjectVariable" DROP CONSTRAINT "ProjectVariable_projectId_fkey";

-- AlterTable
ALTER TABLE "Skill" DROP COLUMN "mode";

-- DropTable
DROP TABLE "LlmSettings";

-- DropTable
DROP TABLE "ProjectVariable";
