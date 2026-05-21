-- NOTE: The backfill below uses hardcoded orgId/teamId values for the initial
-- production deployment (Mirantis org / Lens team). Other environments should
-- update these IDs before running, or run a separate backfill script.
-- This is a one-time migration.

-- Add org/team columns to agents table (nullable first for backfill)
ALTER TABLE "agents" ADD COLUMN "orgId" TEXT;
ALTER TABLE "agents" ADD COLUMN "teamId" TEXT;

-- Backfill existing agents to Mirantis org / Lens team
UPDATE "agents" SET "orgId" = '27c0454b-2cf6-4883-801c-b721150ae3b5', "teamId" = 'e3f63f59-35fe-47c1-94e5-a0139a16a70a' WHERE "orgId" IS NULL;

-- Make columns required
ALTER TABLE "agents" ALTER COLUMN "orgId" SET NOT NULL;
ALTER TABLE "agents" ALTER COLUMN "teamId" SET NOT NULL;

-- Add indexes
CREATE INDEX "agents_orgId_idx" ON "agents"("orgId");
CREATE INDEX "agents_teamId_idx" ON "agents"("teamId");
CREATE INDEX "agents_orgId_teamId_idx" ON "agents"("orgId", "teamId");
