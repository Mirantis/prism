-- AlterTable
ALTER TABLE "agent_workspaces" ADD COLUMN "heartbeatDeliverTo" TEXT NOT NULL DEFAULT 'all';
ALTER TABLE "agent_workspaces" ADD COLUMN "heartbeatChannelIds" TEXT;
