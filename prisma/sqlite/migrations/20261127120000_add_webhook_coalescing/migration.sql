-- AlterTable
ALTER TABLE "webhook_subscriptions" ADD COLUMN "coalesceSeconds" INTEGER;

-- AlterTable
ALTER TABLE "webhook_runs" ADD COLUMN "coalescedInto" TEXT;
