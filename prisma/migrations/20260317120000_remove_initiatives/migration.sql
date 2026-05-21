-- Remove INITIATIVE_WORK from ActivityType enum
-- First delete any rows that reference the old enum value
DELETE FROM "agent_activities" WHERE "type" = 'INITIATIVE_WORK';

-- Recreate ActivityType enum without INITIATIVE_WORK
CREATE TYPE "ActivityType_new" AS ENUM ('HEARTBEAT', 'CHAT', 'CRON', 'DIRECTIVE_CHECK', 'TASK_WORK');
ALTER TABLE "agent_activities" ALTER COLUMN "type" TYPE "ActivityType_new" USING ("type"::text::"ActivityType_new");
ALTER TYPE "ActivityType" RENAME TO "ActivityType_old";
ALTER TYPE "ActivityType_new" RENAME TO "ActivityType";
DROP TYPE "ActivityType_old";

-- Drop agent_initiatives table
DROP TABLE IF EXISTS "agent_initiatives";

-- Drop InitiativeStatus enum
DROP TYPE IF EXISTS "InitiativeStatus";
