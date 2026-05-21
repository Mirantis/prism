-- DropIndex: Remove unique constraint on userId to allow multiple triggers per user
DROP INDEX "slack_heartbeat_triggers_userId_key";

-- CreateIndex: Add regular index for efficient lookups
CREATE INDEX "slack_heartbeat_triggers_userId_idx" ON "slack_heartbeat_triggers"("userId");
