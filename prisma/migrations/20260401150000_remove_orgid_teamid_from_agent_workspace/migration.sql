-- Remove orgId and teamId from agent_workspaces (now stored in backend-only agents table)
DROP INDEX IF EXISTS "agent_workspaces_orgId_idx";
DROP INDEX IF EXISTS "agent_workspaces_teamId_idx";
DROP INDEX IF EXISTS "agent_workspaces_orgId_teamId_idx";
ALTER TABLE "agent_workspaces" DROP COLUMN "orgId";
ALTER TABLE "agent_workspaces" DROP COLUMN "teamId";
