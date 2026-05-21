-- Add GitHub integration fields to personal_agents table
ALTER TABLE "personal_agents" ADD COLUMN IF NOT EXISTS "githubAccessToken" TEXT;
ALTER TABLE "personal_agents" ADD COLUMN IF NOT EXISTS "githubRefreshToken" TEXT;
ALTER TABLE "personal_agents" ADD COLUMN IF NOT EXISTS "githubUsername" TEXT;
ALTER TABLE "personal_agents" ADD COLUMN IF NOT EXISTS "githubConnectedAt" TIMESTAMP(3);
