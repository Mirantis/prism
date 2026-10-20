-- AlterTable
ALTER TABLE "agent_workspaces" ADD COLUMN "modelMode" TEXT;
ALTER TABLE "agent_workspaces" ADD COLUMN "smallModel" TEXT;
ALTER TABLE "agent_workspaces" ADD COLUMN "mediumModel" TEXT;
ALTER TABLE "agent_workspaces" ADD COLUMN "largeModel" TEXT;

-- CreateIndex
CREATE INDEX "llm_calls_agentId_threadId_createdAt_idx" ON "llm_calls"("agentId", "threadId", "createdAt");
