-- AlterTable: update default heartbeat interval from 30 minutes to 8 hours
ALTER TABLE "agents" ALTER COLUMN "heartbeatIntervalMs" SET DEFAULT 28800000;
