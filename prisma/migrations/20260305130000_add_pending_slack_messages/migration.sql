-- CreateTable
CREATE TABLE "pending_slack_messages" (
    "id" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "sender" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "timestamp" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pending_slack_messages_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "pending_slack_messages_agentId_createdAt_idx" ON "pending_slack_messages"("agentId", "createdAt");

-- AddForeignKey
ALTER TABLE "pending_slack_messages" ADD CONSTRAINT "pending_slack_messages_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;
