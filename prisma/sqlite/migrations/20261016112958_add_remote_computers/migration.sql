-- CreateTable
CREATE TABLE "remote_computers" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "agentId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "installationId" TEXT,
    "platform" TEXT,
    "clientVersion" TEXT,
    "lastConnectedAt" DATETIME,
    "lastSeenAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "remote_computers_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "agent_workspaces" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "remote_computers_agentId_name_key" ON "remote_computers"("agentId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "remote_computers_agentId_installationId_key" ON "remote_computers"("agentId", "installationId");
