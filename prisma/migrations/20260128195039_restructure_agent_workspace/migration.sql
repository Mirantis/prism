-- CreateEnum
CREATE TYPE "AgentStatus" AS ENUM ('IDLE', 'RUNNING', 'ERROR');

-- CreateEnum
CREATE TYPE "GoalStatus" AS ENUM ('ACTIVE', 'COMPLETED', 'ABANDONED');

-- CreateEnum
CREATE TYPE "ThreadStatus" AS ENUM ('ACTIVE', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "MessageRole" AS ENUM ('USER', 'AGENT', 'SYSTEM');

-- CreateEnum
CREATE TYPE "MessageTrigger" AS ENUM ('USER_INPUT', 'HEARTBEAT', 'CRON_TASK', 'SYSTEM');

-- CreateEnum
CREATE TYPE "TaskStatus" AS ENUM ('PENDING', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "NotificationType" AS ENUM ('INSIGHT', 'ALERT', 'QUESTION', 'HEARTBEAT', 'GOAL_PROGRESS');

-- CreateEnum
CREATE TYPE "Urgency" AS ENUM ('LOW', 'NORMAL', 'HIGH', 'CRITICAL');

-- CreateEnum
CREATE TYPE "NotificationStatus" AS ENUM ('PENDING', 'DELIVERED', 'READ', 'DISMISSED');

-- CreateEnum
CREATE TYPE "ActivityType" AS ENUM ('HEARTBEAT', 'CHAT', 'CRON', 'DIRECTIVE_CHECK', 'TASK_WORK');

-- CreateTable
CREATE TABLE "personal_agents" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL DEFAULT 'Prism',
    "soulMd" TEXT NOT NULL,
    "userMd" TEXT NOT NULL,
    "memoryMd" TEXT NOT NULL,
    "heartbeatMd" TEXT NOT NULL,
    "bootstrapMd" TEXT NOT NULL,
    "heartbeatIntervalMs" INTEGER NOT NULL DEFAULT 1800000,
    "proactivity" INTEGER NOT NULL DEFAULT 3,
    "verbosity" INTEGER NOT NULL DEFAULT 3,
    "timezone" TEXT NOT NULL DEFAULT 'UTC',
    "dailyResetHour" INTEGER NOT NULL DEFAULT 4,
    "idleTimeoutMins" INTEGER,
    "lensCloudAccessToken" TEXT,
    "lensCloudRefreshToken" TEXT,
    "tokenExpiresAt" TIMESTAMP(3),
    "lastTokenRefresh" TIMESTAMP(3),
    "connectedClusters" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "lastClusterSync" TIMESTAMP(3),
    "status" "AgentStatus" NOT NULL DEFAULT 'IDLE',
    "lastHeartbeat" TIMESTAMP(3),
    "currentSessionId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "personal_agents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "directives" (
    "id" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "instruction" TEXT NOT NULL,
    "priority" INTEGER NOT NULL DEFAULT 5,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "clusterScope" TEXT,
    "namespaceScope" TEXT,
    "cooldownMins" INTEGER NOT NULL DEFAULT 30,
    "lastTriggeredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdVia" TEXT NOT NULL DEFAULT 'conversation',

    CONSTRAINT "directives_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "goals" (
    "id" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "progress" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "status" "GoalStatus" NOT NULL DEFAULT 'ACTIVE',
    "metrics" JSONB,
    "lastUpdated" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "goals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "conversation_threads" (
    "id" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "title" TEXT,
    "status" "ThreadStatus" NOT NULL DEFAULT 'ACTIVE',
    "compactionSummary" TEXT,
    "compactedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "conversation_threads_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "conversation_messages" (
    "id" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "role" "MessageRole" NOT NULL,
    "content" TEXT NOT NULL,
    "triggeredBy" "MessageTrigger" NOT NULL,
    "toolCalls" JSONB,
    "blocks" JSONB,
    "tokenCount" INTEGER,
    "isCompacted" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "conversation_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cron_tasks" (
    "id" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "schedule" TEXT NOT NULL,
    "instruction" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "lastRunAt" TIMESTAMP(3),
    "nextRunAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "cron_tasks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "memory_entries" (
    "id" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "importance" INTEGER NOT NULL DEFAULT 5,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "memory_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_tasks" (
    "id" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "status" "TaskStatus" NOT NULL DEFAULT 'PENDING',
    "priority" INTEGER NOT NULL DEFAULT 5,
    "dueAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdBy" TEXT NOT NULL,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agent_tasks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_notifications" (
    "id" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" "NotificationType" NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "urgency" "Urgency" NOT NULL DEFAULT 'NORMAL',
    "status" "NotificationStatus" NOT NULL DEFAULT 'PENDING',
    "deliveredAt" TIMESTAMP(3),
    "readAt" TIMESTAMP(3),
    "actions" JSONB,
    "relatedThreadId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_activities" (
    "id" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "type" "ActivityType" NOT NULL,
    "action" TEXT NOT NULL,
    "details" JSONB,
    "triggeredBy" TEXT NOT NULL,
    "duration" INTEGER,
    "tokensUsed" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_activities_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "personal_agents_userId_key" ON "personal_agents"("userId");

-- CreateIndex
CREATE INDEX "memory_entries_agentId_createdAt_idx" ON "memory_entries"("agentId", "createdAt");

-- CreateIndex
CREATE INDEX "memory_entries_agentId_category_idx" ON "memory_entries"("agentId", "category");

-- AddForeignKey
ALTER TABLE "directives" ADD CONSTRAINT "directives_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "personal_agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "goals" ADD CONSTRAINT "goals_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "personal_agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversation_threads" ADD CONSTRAINT "conversation_threads_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "personal_agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversation_messages" ADD CONSTRAINT "conversation_messages_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "conversation_threads"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cron_tasks" ADD CONSTRAINT "cron_tasks_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "personal_agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memory_entries" ADD CONSTRAINT "memory_entries_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "personal_agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_tasks" ADD CONSTRAINT "agent_tasks_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "personal_agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_notifications" ADD CONSTRAINT "agent_notifications_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "personal_agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_activities" ADD CONSTRAINT "agent_activities_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "personal_agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;
