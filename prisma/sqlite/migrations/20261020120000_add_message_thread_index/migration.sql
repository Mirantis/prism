-- CreateIndex
CREATE INDEX "conversation_messages_threadId_createdAt_idx" ON "conversation_messages"("threadId", "createdAt");
