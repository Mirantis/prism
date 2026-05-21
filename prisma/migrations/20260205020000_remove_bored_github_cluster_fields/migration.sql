-- Remove BoreD / Lens Cloud authentication fields
ALTER TABLE "personal_agents" DROP COLUMN IF EXISTS "lensCloudAccessToken";
ALTER TABLE "personal_agents" DROP COLUMN IF EXISTS "lensCloudRefreshToken";
ALTER TABLE "personal_agents" DROP COLUMN IF EXISTS "tokenExpiresAt";
ALTER TABLE "personal_agents" DROP COLUMN IF EXISTS "lastTokenRefresh";

-- Remove direct GitHub OAuth fields
ALTER TABLE "personal_agents" DROP COLUMN IF EXISTS "githubAccessToken";
ALTER TABLE "personal_agents" DROP COLUMN IF EXISTS "githubRefreshToken";
ALTER TABLE "personal_agents" DROP COLUMN IF EXISTS "githubUsername";
ALTER TABLE "personal_agents" DROP COLUMN IF EXISTS "githubConnectedAt";

-- Remove cluster connection state fields
ALTER TABLE "personal_agents" DROP COLUMN IF EXISTS "connectedClusters";
ALTER TABLE "personal_agents" DROP COLUMN IF EXISTS "lastClusterSync";
