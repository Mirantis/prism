/*
  Warnings:

  - You are about to drop the column `proactivity` on the `agent_workspaces` table. All the data in the column will be lost.
  - You are about to drop the column `verbosity` on the `agent_workspaces` table. All the data in the column will be lost.

*/
-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_agent_workspaces" (
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
    "timezone" TEXT NOT NULL DEFAULT 'UTC',
    "model" TEXT,
    "heartbeatModel" TEXT,
    "cronModel" TEXT,
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
INSERT INTO "new_agent_workspaces" ("agentMd", "agentType", "bootstrapMd", "createdAt", "cronModel", "currentSessionId", "dailyResetHour", "heartbeatIntervalMs", "heartbeatMd", "heartbeatModel", "heartbeatStatus", "id", "idleTimeoutMins", "lastHeartbeat", "memoryMd", "model", "name", "nexusAgentTokenId", "nexusMcpAgentToken", "soulMd", "status", "timezone", "updatedAt", "userId", "userMd", "visionMd") SELECT "agentMd", "agentType", "bootstrapMd", "createdAt", "cronModel", "currentSessionId", "dailyResetHour", "heartbeatIntervalMs", "heartbeatMd", "heartbeatModel", "heartbeatStatus", "id", "idleTimeoutMins", "lastHeartbeat", "memoryMd", "model", "name", "nexusAgentTokenId", "nexusMcpAgentToken", "soulMd", "status", "timezone", "updatedAt", "userId", "userMd", "visionMd" FROM "agent_workspaces";
DROP TABLE "agent_workspaces";
ALTER TABLE "new_agent_workspaces" RENAME TO "agent_workspaces";
CREATE INDEX "agent_workspaces_userId_idx" ON "agent_workspaces"("userId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
