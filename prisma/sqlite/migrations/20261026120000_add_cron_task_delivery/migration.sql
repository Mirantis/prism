-- AlterTable
ALTER TABLE "cron_tasks" ADD COLUMN "deliverTo" TEXT NOT NULL DEFAULT 'all';
ALTER TABLE "cron_tasks" ADD COLUMN "channelIds" TEXT;
