-- Rename personal_agents table to agents
ALTER TABLE "personal_agents" RENAME TO "agents";

-- Update foreign key references from personal_agents to agents
-- First drop the existing foreign keys
ALTER TABLE "conversation_threads" DROP CONSTRAINT IF EXISTS "conversation_threads_agentId_fkey";
ALTER TABLE "cron_tasks" DROP CONSTRAINT IF EXISTS "cron_tasks_agentId_fkey";
ALTER TABLE "memory_entries" DROP CONSTRAINT IF EXISTS "memory_entries_agentId_fkey";
ALTER TABLE "agent_tasks" DROP CONSTRAINT IF EXISTS "agent_tasks_agentId_fkey";
ALTER TABLE "agent_notifications" DROP CONSTRAINT IF EXISTS "agent_notifications_agentId_fkey";
ALTER TABLE "agent_activities" DROP CONSTRAINT IF EXISTS "agent_activities_agentId_fkey";
ALTER TABLE "agent_initiatives" DROP CONSTRAINT IF EXISTS "agent_initiatives_agentId_fkey";
ALTER TABLE "slack_connections" DROP CONSTRAINT IF EXISTS "slack_connections_userId_fkey";

-- Re-create foreign keys pointing to agents table
ALTER TABLE "conversation_threads" ADD CONSTRAINT "conversation_threads_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "cron_tasks" ADD CONSTRAINT "cron_tasks_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "memory_entries" ADD CONSTRAINT "memory_entries_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "agent_tasks" ADD CONSTRAINT "agent_tasks_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "agent_notifications" ADD CONSTRAINT "agent_notifications_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "agent_activities" ADD CONSTRAINT "agent_activities_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "agent_initiatives" ADD CONSTRAINT "agent_initiatives_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "slack_connections" ADD CONSTRAINT "slack_connections_userId_fkey" FOREIGN KEY ("userId") REFERENCES "agents"("userId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Rename slack_user_mappings table to slack_mappings
ALTER TABLE "slack_user_mappings" RENAME TO "slack_mappings";

-- Update constraints and indexes for renamed table
ALTER INDEX IF EXISTS "slack_user_mappings_lensUserId_idx" RENAME TO "slack_mappings_lensUserId_idx";
ALTER INDEX IF EXISTS "slack_user_mappings_connectionId_slackUserId_key" RENAME TO "slack_mappings_connectionId_slackUserId_key";

-- Drop the old foreign key and recreate with new table name
ALTER TABLE "slack_mappings" DROP CONSTRAINT IF EXISTS "slack_user_mappings_connectionId_fkey";
ALTER TABLE "slack_mappings" ADD CONSTRAINT "slack_mappings_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "slack_connections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Alter slack_mappings columns - make slackUserId and lensUserId nullable for channel mappings
ALTER TABLE "slack_mappings" ALTER COLUMN "slackUserId" DROP NOT NULL;
ALTER TABLE "slack_mappings" ALTER COLUMN "lensUserId" DROP NOT NULL;

-- Add channel mapping columns to slack_mappings
ALTER TABLE "slack_mappings" ADD COLUMN "slackChannelId" TEXT;
ALTER TABLE "slack_mappings" ADD COLUMN "slackChannelName" TEXT;

-- CreateIndex for unique channel mapping
CREATE UNIQUE INDEX "slack_mappings_slackChannelId_key" ON "slack_mappings"("slackChannelId");

-- Add sender fields to conversation_messages for multi-user context
ALTER TABLE "conversation_messages" ADD COLUMN "senderExternalId" TEXT;
ALTER TABLE "conversation_messages" ADD COLUMN "senderName" TEXT;

-- CreateTable for conversation_participants
CREATE TABLE "conversation_participants" (
    "id" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "externalUserId" TEXT NOT NULL,
    "displayName" TEXT,
    "channel" TEXT NOT NULL,
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "conversation_participants_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "conversation_participants_threadId_externalUserId_channel_key" ON "conversation_participants"("threadId", "externalUserId", "channel");

-- AddForeignKey
ALTER TABLE "conversation_participants" ADD CONSTRAINT "conversation_participants_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "conversation_threads"("id") ON DELETE CASCADE ON UPDATE CASCADE;
