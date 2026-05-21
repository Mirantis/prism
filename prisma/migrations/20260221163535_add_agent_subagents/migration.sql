-- AlterTable
ALTER TABLE "agents" RENAME CONSTRAINT "personal_agents_pkey" TO "agents_pkey";
ALTER TABLE "agents" ALTER COLUMN "name" SET DEFAULT 'Prism Agent';

-- AlterTable
ALTER TABLE "slack_mappings" RENAME CONSTRAINT "slack_user_mappings_pkey" TO "slack_mappings_pkey";

-- CreateTable
CREATE TABLE "agent_subagents" (
    "id" TEXT NOT NULL,
    "parentAgentId" TEXT NOT NULL,
    "childAgentId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_subagents_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "agent_subagents_parentAgentId_idx" ON "agent_subagents"("parentAgentId");

-- CreateIndex
CREATE INDEX "agent_subagents_childAgentId_idx" ON "agent_subagents"("childAgentId");

-- CreateIndex
CREATE UNIQUE INDEX "agent_subagents_parentAgentId_childAgentId_key" ON "agent_subagents"("parentAgentId", "childAgentId");

-- AddForeignKey
ALTER TABLE "agent_subagents" ADD CONSTRAINT "agent_subagents_parentAgentId_fkey" FOREIGN KEY ("parentAgentId") REFERENCES "agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_subagents" ADD CONSTRAINT "agent_subagents_childAgentId_fkey" FOREIGN KEY ("childAgentId") REFERENCES "agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;
