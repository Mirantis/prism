-- Allow multiple agents per user (e.g. subagents)
-- Removes the unique constraint on agents.userId and adds a regular index

-- Step 1: Add agentId column to slack_connections (nullable initially for migration)
ALTER TABLE "slack_connections" ADD COLUMN "agentId" TEXT;

-- Step 2: Populate agentId from existing data
-- Each slack_connection has a userId that maps to an agent's userId
UPDATE "slack_connections" sc
SET "agentId" = a."id"
FROM "agents" a
WHERE sc."userId" = a."userId";

-- Step 3: Make agentId NOT NULL now that data is populated
ALTER TABLE "slack_connections" ALTER COLUMN "agentId" SET NOT NULL;

-- Step 4: Drop the old FK from slack_connections.userId -> agents.userId
ALTER TABLE "slack_connections" DROP CONSTRAINT IF EXISTS "slack_connections_userId_fkey";

-- Step 5: Drop the unique index on agents.userId
DROP INDEX IF EXISTS "personal_agents_userId_key";

-- Step 6: Create a regular (non-unique) index on agents.userId
CREATE INDEX "agents_userId_idx" ON "agents"("userId");

-- Step 7: Add new FK from slack_connections.agentId -> agents.id
ALTER TABLE "slack_connections" ADD CONSTRAINT "slack_connections_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;
