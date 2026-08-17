-- CreateTable
CREATE TABLE "teams_mappings" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "connectionId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "tenantId" TEXT,
    "teamsUserId" TEXT,
    "lensUserId" TEXT,
    "dmConversationId" TEXT,
    "channelConversationId" TEXT,
    "channelName" TEXT,
    "isMainChannel" BOOLEAN NOT NULL DEFAULT false,
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

-- CreateIndex
CREATE UNIQUE INDEX "teams_mappings_channelConversationId_key" ON "teams_mappings"("channelConversationId");

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
