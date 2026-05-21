-- AlterTable: Add agentId to slack_mappings (nullable first for backfill)
ALTER TABLE "slack_mappings" ADD COLUMN "agentId" TEXT;

-- Backfill: Copy agentId from parent SlackConnection
UPDATE "slack_mappings" sm
SET "agentId" = sc."agentId"
FROM "slack_connections" sc
WHERE sm."connectionId" = sc."id";

-- Make non-nullable after backfill
ALTER TABLE "slack_mappings" ALTER COLUMN "agentId" SET NOT NULL;

-- AddForeignKey
ALTER TABLE "slack_mappings" ADD CONSTRAINT "slack_mappings_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateIndex
CREATE INDEX "slack_mappings_agentId_idx" ON "slack_mappings"("agentId");
