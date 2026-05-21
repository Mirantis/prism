-- CreateEnum
CREATE TYPE "InitiativeStatus" AS ENUM ('PROPOSED', 'APPROVED', 'IN_PROGRESS', 'BLOCKED', 'COMPLETED', 'ABANDONED');

-- AlterEnum
ALTER TYPE "ActivityType" ADD VALUE 'INITIATIVE_WORK';

-- AlterTable
ALTER TABLE "personal_agents" ADD COLUMN     "visionMd" TEXT NOT NULL DEFAULT '';

-- CreateTable
CREATE TABLE "agent_initiatives" (
    "id" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "rationale" TEXT NOT NULL,
    "status" "InitiativeStatus" NOT NULL DEFAULT 'PROPOSED',
    "priority" INTEGER NOT NULL DEFAULT 5,
    "progressPct" INTEGER NOT NULL DEFAULT 0,
    "nextSteps" TEXT,
    "blockers" TEXT,
    "autoApproved" BOOLEAN NOT NULL DEFAULT false,
    "approvedAt" TIMESTAMP(3),
    "approvedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "agent_initiatives_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "agent_initiatives_agentId_status_idx" ON "agent_initiatives"("agentId", "status");

-- CreateIndex
CREATE INDEX "agent_initiatives_agentId_createdAt_idx" ON "agent_initiatives"("agentId", "createdAt");

-- AddForeignKey
ALTER TABLE "agent_initiatives" ADD CONSTRAINT "agent_initiatives_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "personal_agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;
