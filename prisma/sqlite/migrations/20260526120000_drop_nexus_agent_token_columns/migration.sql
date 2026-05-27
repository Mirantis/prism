-- DropColumn — nexus agent token plumbing is gone (runtime no longer
-- resolves a per-agent Nexus token; auth happens at the gateway).
ALTER TABLE "agent_workspaces" DROP COLUMN "nexusMcpAgentToken";
ALTER TABLE "agent_workspaces" DROP COLUMN "nexusAgentTokenId";
