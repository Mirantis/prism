-- AlterTable: Add unique constraint on userId (1 trigger per user)
CREATE UNIQUE INDEX "slack_heartbeat_triggers_userId_key" ON "slack_heartbeat_triggers"("userId");
