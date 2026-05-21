-- Remove FK constraints referencing slack_connections in the shared database.
-- SlackConnection data lives exclusively in the backend-only database (lens_agents_backend).
-- The connectionId columns are kept as plain strings.

-- Drop FK from slack_mappings -> slack_connections
ALTER TABLE "slack_mappings" DROP CONSTRAINT IF EXISTS "slack_mappings_connectionId_fkey";

-- Drop FK from slack_verification_codes -> slack_connections
ALTER TABLE "slack_verification_codes" DROP CONSTRAINT IF EXISTS "slack_verification_codes_connectionId_fkey";

-- Drop FK from slack_heartbeat_triggers -> slack_connections
ALTER TABLE "slack_heartbeat_triggers" DROP CONSTRAINT IF EXISTS "slack_heartbeat_triggers_connectionId_fkey";

-- Drop FK from slack_connections -> agents (table may not exist in fresh databases)
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'slack_connections') THEN
    ALTER TABLE "slack_connections" DROP CONSTRAINT IF EXISTS "slack_connections_agentId_fkey";
  END IF;
END $$;

-- Add indexes on connectionId where they were previously covered by the FK
CREATE INDEX IF NOT EXISTS "slack_mappings_connectionId_idx" ON "slack_mappings"("connectionId");
CREATE INDEX IF NOT EXISTS "slack_heartbeat_triggers_connectionId_idx" ON "slack_heartbeat_triggers"("connectionId");
