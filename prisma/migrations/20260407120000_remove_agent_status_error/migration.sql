-- Update any agents currently in ERROR state to IDLE before removing the enum value
UPDATE "agent_workspaces" SET "status" = 'IDLE' WHERE "status" = 'ERROR';

-- Recreate AgentStatus enum without ERROR
-- Must drop the column default first, then re-add after type change
CREATE TYPE "AgentStatus_new" AS ENUM ('IDLE', 'RUNNING');
ALTER TABLE "agent_workspaces" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "agent_workspaces" ALTER COLUMN "status" TYPE "AgentStatus_new" USING ("status"::text::"AgentStatus_new");
ALTER TABLE "agent_workspaces" ALTER COLUMN "status" SET DEFAULT 'IDLE'::"AgentStatus_new";
ALTER TYPE "AgentStatus" RENAME TO "AgentStatus_old";
ALTER TYPE "AgentStatus_new" RENAME TO "AgentStatus";
DROP TYPE "AgentStatus_old";
