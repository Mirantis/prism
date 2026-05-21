-- CreateTable
CREATE TABLE "agent_workspaces" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL DEFAULT 'Prism Agent',
    "agentType" TEXT NOT NULL DEFAULT 'AGENT',
    "soulMd" TEXT NOT NULL,
    "userMd" TEXT NOT NULL,
    "memoryMd" TEXT NOT NULL,
    "heartbeatMd" TEXT NOT NULL,
    "visionMd" TEXT NOT NULL DEFAULT '',
    "agentMd" TEXT NOT NULL DEFAULT '',
    "bootstrapMd" TEXT NOT NULL,
    "heartbeatIntervalMs" INTEGER NOT NULL DEFAULT 28800000,
    "heartbeatStatus" TEXT NOT NULL DEFAULT 'ENABLED',
    "proactivity" INTEGER NOT NULL DEFAULT 3,
    "verbosity" INTEGER NOT NULL DEFAULT 3,
    "timezone" TEXT NOT NULL DEFAULT 'UTC',
    "dailyResetHour" INTEGER NOT NULL DEFAULT 4,
    "idleTimeoutMins" INTEGER,
    "nexusMcpAgentToken" TEXT,
    "nexusAgentTokenId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'IDLE',
    "lastHeartbeat" DATETIME,
    "currentSessionId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "conversation_threads" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "agentId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "title" TEXT,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "externalThreadId" TEXT,
    "threadSource" TEXT NOT NULL DEFAULT 'DATABASE',
    "externalChannelId" TEXT,
    "compactionSummary" TEXT,
    "compactedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "conversation_threads_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "agent_workspaces" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "conversation_messages" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "threadId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "triggeredBy" TEXT NOT NULL,
    "toolCalls" JSONB,
    "blocks" JSONB,
    "tokenCount" INTEGER,
    "senderExternalId" TEXT,
    "senderName" TEXT,
    "externalMessageId" TEXT,
    "isCompacted" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "conversation_messages_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "conversation_threads" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "conversation_participants" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "threadId" TEXT NOT NULL,
    "externalUserId" TEXT NOT NULL,
    "displayName" TEXT,
    "channel" TEXT NOT NULL,
    "joinedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "conversation_participants_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "conversation_threads" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "cron_tasks" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "agentId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "schedule" TEXT NOT NULL,
    "instruction" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "lastRunAt" DATETIME,
    "nextRunAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "cron_tasks_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "agent_workspaces" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "memory_entries" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "agentId" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "importance" INTEGER NOT NULL DEFAULT 5,
    "embedding" BLOB,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "memory_entries_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "agent_workspaces" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "slack_mappings" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "connectionId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "slackUserId" TEXT,
    "lensUserId" TEXT,
    "dmChannelId" TEXT,
    "slackChannelId" TEXT,
    "slackChannelName" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "slack_mappings_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "agent_workspaces" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "slack_verification_codes" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "code" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "lensUserId" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "agentName" TEXT,
    "expiresAt" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "slack_verification_codes_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "agent_workspaces" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "agent_subagents" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "parentAgentId" TEXT NOT NULL,
    "childAgentId" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "agent_subagents_parentAgentId_fkey" FOREIGN KEY ("parentAgentId") REFERENCES "agent_workspaces" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "agent_subagents_childAgentId_fkey" FOREIGN KEY ("childAgentId") REFERENCES "agent_workspaces" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "slack_heartbeat_triggers" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "connectionId" TEXT NOT NULL,
    "slackChannelId" TEXT NOT NULL,
    "slackChannelName" TEXT,
    "agentId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "throttle_seconds" INTEGER NOT NULL DEFAULT 60,
    "last_triggered_at" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "slack_heartbeat_triggers_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "agent_workspaces" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "pending_slack_messages" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "agentId" TEXT NOT NULL,
    "sender" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "timestamp" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "pending_slack_messages_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "agent_workspaces" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "agent_workspaces_userId_idx" ON "agent_workspaces"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "conversation_threads_agentId_userId_externalThreadId_key" ON "conversation_threads"("agentId", "userId", "externalThreadId");

-- CreateIndex
CREATE UNIQUE INDEX "conversation_participants_threadId_externalUserId_channel_key" ON "conversation_participants"("threadId", "externalUserId", "channel");

-- CreateIndex
CREATE INDEX "memory_entries_agentId_createdAt_idx" ON "memory_entries"("agentId", "createdAt");

-- CreateIndex
CREATE INDEX "memory_entries_agentId_category_idx" ON "memory_entries"("agentId", "category");

-- CreateIndex
CREATE UNIQUE INDEX "slack_mappings_slackChannelId_key" ON "slack_mappings"("slackChannelId");

-- CreateIndex
CREATE INDEX "slack_mappings_connectionId_idx" ON "slack_mappings"("connectionId");

-- CreateIndex
CREATE INDEX "slack_mappings_lensUserId_idx" ON "slack_mappings"("lensUserId");

-- CreateIndex
CREATE INDEX "slack_mappings_agentId_idx" ON "slack_mappings"("agentId");

-- CreateIndex
CREATE UNIQUE INDEX "slack_mappings_connectionId_slackUserId_key" ON "slack_mappings"("connectionId", "slackUserId");

-- CreateIndex
CREATE INDEX "slack_verification_codes_expiresAt_idx" ON "slack_verification_codes"("expiresAt");

-- CreateIndex
CREATE INDEX "slack_verification_codes_connectionId_idx" ON "slack_verification_codes"("connectionId");

-- CreateIndex
CREATE INDEX "slack_verification_codes_agentId_idx" ON "slack_verification_codes"("agentId");

-- CreateIndex
CREATE UNIQUE INDEX "slack_verification_codes_code_type_key" ON "slack_verification_codes"("code", "type");

-- CreateIndex
CREATE INDEX "agent_subagents_parentAgentId_idx" ON "agent_subagents"("parentAgentId");

-- CreateIndex
CREATE INDEX "agent_subagents_childAgentId_idx" ON "agent_subagents"("childAgentId");

-- CreateIndex
CREATE UNIQUE INDEX "agent_subagents_parentAgentId_childAgentId_key" ON "agent_subagents"("parentAgentId", "childAgentId");

-- CreateIndex
CREATE UNIQUE INDEX "slack_heartbeat_triggers_slackChannelId_key" ON "slack_heartbeat_triggers"("slackChannelId");

-- CreateIndex
CREATE UNIQUE INDEX "slack_heartbeat_triggers_agentId_key" ON "slack_heartbeat_triggers"("agentId");

-- CreateIndex
CREATE INDEX "slack_heartbeat_triggers_connectionId_idx" ON "slack_heartbeat_triggers"("connectionId");

-- CreateIndex
CREATE INDEX "slack_heartbeat_triggers_userId_idx" ON "slack_heartbeat_triggers"("userId");

-- CreateIndex
CREATE INDEX "pending_slack_messages_agentId_createdAt_idx" ON "pending_slack_messages"("agentId", "createdAt");
