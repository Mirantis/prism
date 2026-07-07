-- AlterTable
ALTER TABLE "agent_workspaces" ADD COLUMN "webhooksEnabled" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "webhook_subscriptions" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "agentId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "events" TEXT,
    "prompt" TEXT,
    "deliverTo" TEXT NOT NULL DEFAULT 'all',
    "deliverOnly" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "webhook_subscriptions_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "agent_workspaces" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "webhook_subscriptions_name_key" ON "webhook_subscriptions"("name");

-- CreateIndex
CREATE INDEX "webhook_subscriptions_agentId_idx" ON "webhook_subscriptions"("agentId");
