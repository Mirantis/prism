-- AlterTable
ALTER TABLE "slack_heartbeat_triggers" ADD COLUMN "throttle_seconds" INTEGER NOT NULL DEFAULT 60;
ALTER TABLE "slack_heartbeat_triggers" ADD COLUMN "last_triggered_at" TIMESTAMP(3);
