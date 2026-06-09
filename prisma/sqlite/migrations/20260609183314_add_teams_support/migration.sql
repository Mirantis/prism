-- CreateTable
CREATE TABLE "teams_mappings" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "connectionId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "teamsUserId" TEXT,
    "lensUserId" TEXT,
    "personalConversationId" TEXT,
    "conversationReference" JSONB,
    "teamsChannelId" TEXT,
    "teamsChannelName" TEXT,
    "serviceUrl" TEXT,
    "tenantId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "teams_mappings_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "agent_workspaces" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "teams_verification_codes" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "code" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "lensUserId" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "agentName" TEXT,
    "expiresAt" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "teams_verification_codes_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "agent_workspaces" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "teams_heartbeat_triggers" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "connectionId" TEXT NOT NULL,
    "teamsChannelId" TEXT NOT NULL,
    "teamsChannelName" TEXT,
    "agentId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "throttle_seconds" INTEGER NOT NULL DEFAULT 60,
    "last_triggered_at" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "teams_heartbeat_triggers_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "agent_workspaces" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "pending_teams_messages" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "agentId" TEXT NOT NULL,
    "sender" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "timestamp" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "pending_teams_messages_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "agent_workspaces" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "teams_mappings_teamsChannelId_key" ON "teams_mappings"("teamsChannelId");

-- CreateIndex
CREATE INDEX "teams_mappings_connectionId_idx" ON "teams_mappings"("connectionId");

-- CreateIndex
CREATE INDEX "teams_mappings_lensUserId_idx" ON "teams_mappings"("lensUserId");

-- CreateIndex
CREATE INDEX "teams_mappings_agentId_idx" ON "teams_mappings"("agentId");

-- CreateIndex
CREATE UNIQUE INDEX "teams_mappings_connectionId_teamsUserId_key" ON "teams_mappings"("connectionId", "teamsUserId");

-- CreateIndex
CREATE INDEX "teams_verification_codes_expiresAt_idx" ON "teams_verification_codes"("expiresAt");

-- CreateIndex
CREATE INDEX "teams_verification_codes_connectionId_idx" ON "teams_verification_codes"("connectionId");

-- CreateIndex
CREATE INDEX "teams_verification_codes_agentId_idx" ON "teams_verification_codes"("agentId");

-- CreateIndex
CREATE UNIQUE INDEX "teams_verification_codes_code_type_key" ON "teams_verification_codes"("code", "type");

-- CreateIndex
CREATE UNIQUE INDEX "teams_heartbeat_triggers_teamsChannelId_key" ON "teams_heartbeat_triggers"("teamsChannelId");

-- CreateIndex
CREATE UNIQUE INDEX "teams_heartbeat_triggers_agentId_key" ON "teams_heartbeat_triggers"("agentId");

-- CreateIndex
CREATE INDEX "teams_heartbeat_triggers_connectionId_idx" ON "teams_heartbeat_triggers"("connectionId");

-- CreateIndex
CREATE INDEX "teams_heartbeat_triggers_userId_idx" ON "teams_heartbeat_triggers"("userId");

-- CreateIndex
CREATE INDEX "pending_teams_messages_agentId_createdAt_idx" ON "pending_teams_messages"("agentId", "createdAt");
