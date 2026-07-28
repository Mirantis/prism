-- AlterTable
ALTER TABLE "webhook_subscriptions" ADD COLUMN "authType" TEXT NOT NULL DEFAULT 'none';
ALTER TABLE "webhook_subscriptions" ADD COLUMN "authHeader" TEXT;
ALTER TABLE "webhook_subscriptions" ADD COLUMN "authPrefix" TEXT;
ALTER TABLE "webhook_subscriptions" ADD COLUMN "authAlgorithm" TEXT NOT NULL DEFAULT 'sha256';
ALTER TABLE "webhook_subscriptions" ADD COLUMN "authEncoding" TEXT NOT NULL DEFAULT 'hex';
ALTER TABLE "webhook_subscriptions" ADD COLUMN "secret" TEXT;
