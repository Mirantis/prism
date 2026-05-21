-- CreateTable
CREATE TABLE "slack_connections" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "teamName" TEXT NOT NULL,
    "botToken" TEXT NOT NULL,
    "appToken" TEXT,
    "botUserId" TEXT NOT NULL,
    "installedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "slack_connections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "slack_user_mappings" (
    "id" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "slackUserId" TEXT NOT NULL,
    "lensUserId" TEXT NOT NULL,
    "dmChannelId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "slack_user_mappings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "slack_connections_userId_teamId_key" ON "slack_connections"("userId", "teamId");

-- CreateIndex
CREATE INDEX "slack_user_mappings_lensUserId_idx" ON "slack_user_mappings"("lensUserId");

-- CreateIndex
CREATE UNIQUE INDEX "slack_user_mappings_connectionId_slackUserId_key" ON "slack_user_mappings"("connectionId", "slackUserId");

-- AddForeignKey
ALTER TABLE "slack_connections" ADD CONSTRAINT "slack_connections_userId_fkey" FOREIGN KEY ("userId") REFERENCES "personal_agents"("userId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "slack_user_mappings" ADD CONSTRAINT "slack_user_mappings_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "slack_connections"("id") ON DELETE CASCADE ON UPDATE CASCADE;
