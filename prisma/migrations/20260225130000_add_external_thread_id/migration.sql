-- AlterTable
ALTER TABLE "conversation_threads" ADD COLUMN "externalThreadId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "conversation_threads_agentId_userId_externalThreadId_key" ON "conversation_threads"("agentId", "userId", "externalThreadId");
