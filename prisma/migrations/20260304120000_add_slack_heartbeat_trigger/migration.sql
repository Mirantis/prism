-- CreateTable
CREATE TABLE "slack_heartbeat_triggers" (
    "id" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "slackChannelId" TEXT NOT NULL,
    "slackChannelName" TEXT,
    "agentId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "slack_heartbeat_triggers_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "slack_heartbeat_triggers_slackChannelId_key" ON "slack_heartbeat_triggers"("slackChannelId");

-- AddForeignKey
ALTER TABLE "slack_heartbeat_triggers" ADD CONSTRAINT "slack_heartbeat_triggers_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "slack_connections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "slack_heartbeat_triggers" ADD CONSTRAINT "slack_heartbeat_triggers_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;
