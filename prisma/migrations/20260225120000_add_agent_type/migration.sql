-- CreateEnum
CREATE TYPE "AgentType" AS ENUM ('AGENT', 'SUBAGENT');

-- AlterTable
ALTER TABLE "agents" ADD COLUMN "agentType" "AgentType" NOT NULL DEFAULT 'AGENT';
