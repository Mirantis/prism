-- CreateEnum
CREATE TYPE "AgentHeartbeatStatus" AS ENUM ('ENABLED', 'STOPPED');

-- AlterTable
ALTER TABLE "agents" ADD COLUMN     "heartbeatStatus" "AgentHeartbeatStatus" NOT NULL DEFAULT 'ENABLED';

