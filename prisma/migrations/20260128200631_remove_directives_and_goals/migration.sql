/*
  Warnings:

  - You are about to drop the `directives` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `goals` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropForeignKey
ALTER TABLE "directives" DROP CONSTRAINT "directives_agentId_fkey";

-- DropForeignKey
ALTER TABLE "goals" DROP CONSTRAINT "goals_agentId_fkey";

-- DropTable
DROP TABLE "directives";

-- DropTable
DROP TABLE "goals";

-- DropEnum
DROP TYPE "GoalStatus";
