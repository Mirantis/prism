-- CreateTable
CREATE TABLE "webhook_runs" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "agentId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "error" TEXT,
    "messageId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" DATETIME,
    CONSTRAINT "webhook_runs_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "agent_workspaces" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "webhook_runs_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "conversation_messages" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "webhook_runs_messageId_key" ON "webhook_runs"("messageId");

-- CreateIndex
CREATE INDEX "webhook_runs_agentId_createdAt_idx" ON "webhook_runs"("agentId", "createdAt");
