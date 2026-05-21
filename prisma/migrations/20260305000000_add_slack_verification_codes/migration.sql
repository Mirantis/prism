-- CreateEnum
CREATE TYPE "SlackVerificationType" AS ENUM ('DM', 'CHANNEL');

-- CreateTable
CREATE TABLE "slack_verification_codes" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "type" "SlackVerificationType" NOT NULL,
    "lensUserId" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "agentName" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "slack_verification_codes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "slack_verification_codes_expiresAt_idx" ON "slack_verification_codes"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "slack_verification_codes_code_type_key" ON "slack_verification_codes"("code", "type");
