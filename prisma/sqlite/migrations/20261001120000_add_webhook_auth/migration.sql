-- AlterTable
ALTER TABLE "webhook_subscriptions" ADD COLUMN "authType" TEXT NOT NULL DEFAULT 'token';
ALTER TABLE "webhook_subscriptions" ADD COLUMN "authHeader" TEXT;
ALTER TABLE "webhook_subscriptions" ADD COLUMN "authPrefix" TEXT;
ALTER TABLE "webhook_subscriptions" ADD COLUMN "authAlgorithm" TEXT NOT NULL DEFAULT 'sha256';
ALTER TABLE "webhook_subscriptions" ADD COLUMN "authEncoding" TEXT NOT NULL DEFAULT 'hex';
ALTER TABLE "webhook_subscriptions" ADD COLUMN "secret" TEXT;

-- Keep existing subscriptions unverified until their owner configures authentication.
UPDATE "webhook_subscriptions" SET "authType" = 'none';
