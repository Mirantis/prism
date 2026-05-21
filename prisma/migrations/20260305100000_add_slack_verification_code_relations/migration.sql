-- AddForeignKey
ALTER TABLE "slack_verification_codes" ADD CONSTRAINT "slack_verification_codes_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "slack_connections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "slack_verification_codes" ADD CONSTRAINT "slack_verification_codes_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateIndex
CREATE INDEX "slack_verification_codes_connectionId_idx" ON "slack_verification_codes"("connectionId");

-- CreateIndex
CREATE INDEX "slack_verification_codes_agentId_idx" ON "slack_verification_codes"("agentId");
